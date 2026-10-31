"""邮箱接入：IMAP 拉取买家邮件、按会话归并、把回复存入草稿箱（不自动发送）。
未配置邮箱时使用离线样例，保证现场演示可重复。"""

import email
import hashlib
import html
import imaplib
import json
import re
import smtplib
import ssl
import threading
import time
from datetime import datetime, timezone
from email import policy
from email.message import EmailMessage
from email.utils import formatdate, make_msgid, parseaddr, parsedate_to_datetime

from .config import RUNTIME_DIR, SAMPLES_DIR, mail_settings

OFFLINE_ADDRESS = "sales@nordluma.example"
DRAFT_CANDIDATES = ("Drafts", "&g0l6P3ux-", "[Gmail]/Drafts", "INBOX.Drafts", "INBOX/Drafts")
QUOTE_START = re.compile(
    r"^(?:On .+wrote:|Am .+schrieb.*:|-{2,}\s*(?:Original|Ursprüngliche).*|From:\s|Von:\s|发件人[:：]|在.+写道[:：])",
    re.I)
SUBJECT_PREFIX = re.compile(r"^(?:(?:re|aw|fw|fwd|wg|antw|回复|答复|转发)\s*[:：]\s*)+", re.I)
LIST_LINE = re.compile(r'\((?P<flags>[^)]*)\)\s+(?:"[^"]*"|NIL)\s+(?P<name>.+)$')

_lock = threading.RLock()
_threads: dict[str, dict] = {}
_state = {"last_sync": None, "error": None}


class MailboxError(Exception):
    pass


def mode() -> str:
    s = mail_settings()
    return "imap" if s["imap_host"] and s["user"] and s["password"] else "offline"


def own_address() -> str:
    return mail_settings()["user"] if mode() == "imap" else OFFLINE_ADDRESS


def _text_of(msg) -> str:
    part = msg.get_body(preferencelist=("plain", "html"))
    if part is None:
        return ""
    content = part.get_content()
    if part.get_content_type() == "text/html":
        content = re.sub(r"<br\s*/?>|</p>", "\n", content, flags=re.I)
        content = html.unescape(re.sub(r"<[^>]+>", "", content))
    return content.strip()


def parse_message(raw: bytes) -> dict:
    msg = email.message_from_bytes(raw, policy=policy.default)
    from_name, from_addr = parseaddr(str(msg["from"] or ""))
    try:
        date = parsedate_to_datetime(str(msg["date"])).astimezone(timezone.utc).isoformat(timespec="seconds")
    except (TypeError, ValueError):
        date = ""
    return {
        "message_id": str(msg["message-id"] or "").strip() or make_msgid(),
        "in_reply_to": str(msg["in-reply-to"] or "").strip(),
        "references": re.findall(r"<[^>]+>", str(msg["references"] or "")),
        "from_name": from_name,
        "from_addr": from_addr.lower(),
        "subject": str(msg["subject"] or "").strip(),
        "date": date,
        "body": _text_of(msg),
        "attachments": [p.get_filename() for p in msg.iter_attachments() if p.get_filename()],
    }


def strip_quoted(body: str) -> str:
    kept = []
    for line in body.splitlines():
        if QUOTE_START.match(line.strip()):
            break
        if line.lstrip().startswith(">"):
            continue
        kept.append(line)
    return "\n".join(kept).strip()


def normalize_subject(subject: str) -> str:
    return SUBJECT_PREFIX.sub("", subject).strip().lower()


def group_threads(mails: list[dict], own: str) -> dict[str, dict]:
    threads: dict[str, dict] = {}
    id_map: dict[str, str] = {}
    subject_map: dict[tuple, str] = {}
    for m in sorted(mails, key=lambda x: x["date"]):
        m["outbound"] = m["from_addr"] == own.lower()
        counterpart = m["from_addr"]
        thread_id = next((id_map[i] for i in m["references"] + [m["in_reply_to"]] if i in id_map), None)
        subject_key = (normalize_subject(m["subject"]), counterpart)
        if not thread_id:
            thread_id = subject_map.get(subject_key)
        if not thread_id:
            thread_id = "T-" + hashlib.sha1(m["message_id"].encode()).hexdigest()[:10]
            threads[thread_id] = {"thread_id": thread_id, "subject": m["subject"], "buyer_name": m["from_name"],
                                  "buyer_addr": counterpart, "messages": []}
        id_map[m["message_id"]] = thread_id
        subject_map[subject_key] = thread_id
        threads[thread_id]["messages"].append(m)
    return threads


def _connect(s: dict | None = None):
    s = s or mail_settings()
    imap = imaplib.IMAP4_SSL(s["imap_host"], s["imap_port"], timeout=20)
    imap.login(s["user"], s["password"])
    if re.search(r"163\.com|126\.com|yeah\.net", s["imap_host"]):
        imaplib.Commands.setdefault("ID", ("AUTH", "SELECTED"))
        try:
            imap._simple_command("ID", '("name" "TradeTwin" "version" "0.1.0")')
        except imaplib.IMAP4.error:
            pass
    return imap


def _fetch_imap() -> list[dict]:
    limit = mail_settings()["fetch_limit"]
    imap = _connect()
    try:
        typ, _ = imap.select("INBOX", readonly=True)
        if typ != "OK":
            raise MailboxError("无法打开收件箱")
        typ, data = imap.search(None, "ALL")
        ids = data[0].split()[-limit:] if data and data[0] else []
        mails = []
        for num in ids:
            typ, parts = imap.fetch(num, "(BODY.PEEK[])")
            raw = next((p[1] for p in parts if isinstance(p, tuple)), None)
            if typ == "OK" and raw:
                mails.append(parse_message(raw))
        return mails
    finally:
        try:
            imap.logout()
        except imaplib.IMAP4.error:
            pass


def _offline_state_path():
    path = RUNTIME_DIR / "offline-mail.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    return path


def _released() -> list[str]:
    path = _offline_state_path()
    return json.loads(path.read_text(encoding="utf-8")) if path.exists() else []


def _fetch_offline() -> list[dict]:
    mails = [parse_message(p.read_bytes()) for p in sorted((SAMPLES_DIR / "inbox").glob("*.eml"))]
    released = set(_released())
    for p in sorted((SAMPLES_DIR / "followups").glob("*.eml")):
        if p.name in released:
            mails.append(parse_message(p.read_bytes()))
    return mails


def sync() -> list[dict]:
    with _lock:
        try:
            mails = _fetch_imap() if mode() == "imap" else _fetch_offline()
            _state["error"] = None
        except (OSError, imaplib.IMAP4.error, MailboxError) as exc:
            _state["error"] = f"邮箱同步失败：{exc}"
            raise MailboxError(_state["error"]) from exc
        _threads.clear()
        _threads.update(group_threads(mails, own_address()))
        _state["last_sync"] = datetime.now(timezone.utc).isoformat(timespec="seconds")
        return summaries()


def summaries() -> list[dict]:
    out = []
    for t in _threads.values():
        inbound = [m for m in t["messages"] if not m["outbound"]]
        last = inbound[-1] if inbound else t["messages"][-1]
        out.append({
            "thread_id": t["thread_id"],
            "subject": t["subject"],
            "buyer_name": t["buyer_name"],
            "buyer_addr": t["buyer_addr"],
            "message_count": len(t["messages"]),
            "inbound_count": len(inbound),
            "updated_at": t["messages"][-1]["date"],
            "last_message_id": last["message_id"],
            "preview": strip_quoted(last["body"])[:160],
            "attachments": sorted({a for m in t["messages"] for a in m["attachments"]}),
        })
    out.sort(key=lambda x: x["updated_at"], reverse=True)
    return out


def status() -> dict:
    s = mail_settings()
    return {"mode": mode(), "address": own_address(), "source": s["source"],
            "smtp_configured": smtp_configured(), **_state}


def smtp_configured(s: dict | None = None) -> bool:
    s = s or mail_settings()
    return bool(s["smtp_host"] and s["user"] and s["password"])


def invalidate() -> None:
    with _lock:
        _threads.clear()
        _state.update(last_sync=None, error=None)


def _smtp(s: dict):
    if s["smtp_security"] == "starttls":
        server = smtplib.SMTP(s["smtp_host"], s["smtp_port"], timeout=20)
        server.starttls(context=ssl.create_default_context())
    else:
        server = smtplib.SMTP_SSL(s["smtp_host"], s["smtp_port"], timeout=20, context=ssl.create_default_context())
    server.login(s["user"], s["password"])
    return server


def test_connection(s: dict) -> dict:
    out = {"imap": {"ok": False, "message": "未填写 IMAP 服务器、账号或授权码"}, "smtp": None}
    if s["imap_host"] and s["user"] and s["password"]:
        try:
            imap = _connect(s)
            try:
                typ, data = imap.select("INBOX", readonly=True)
                count = int(data[0]) if typ == "OK" and data and data[0] else 0
                try:
                    drafts = _find_drafts(imap, s)
                except MailboxError as exc:
                    drafts = None
                    out["imap"]["drafts_error"] = str(exc)
                out["imap"].update(ok=True, message=f"连接成功：收件箱 {count} 封", inbox_count=count, drafts=drafts)
            finally:
                try:
                    imap.logout()
                except imaplib.IMAP4.error:
                    pass
        except (OSError, imaplib.IMAP4.error) as exc:
            out["imap"]["message"] = f"IMAP 连接失败：{_explain(exc)}"
    if s["smtp_host"]:
        try:
            server = _smtp(s)
            server.quit()
            out["smtp"] = {"ok": True, "message": "SMTP 登录成功"}
        except (OSError, smtplib.SMTPException) as exc:
            out["smtp"] = {"ok": False, "message": f"SMTP 连接失败：{_explain(exc)}"}
    return out


def _explain(exc: Exception) -> str:
    text = str(exc)
    if re.search(r"auth|login|password|LOGIN|535|Unsafe", text, re.I):
        return text + "（请确认已开启 IMAP/SMTP 服务，并填写授权码而不是登录密码）"
    if isinstance(exc, (TimeoutError, OSError)) and "timed out" in text:
        return text + "（服务器地址或端口可能不对，或网络不通）"
    return text


def send_reply(thread_id: str, subject: str, body: str) -> dict:
    if mode() != "imap":
        raise MailboxError("离线演示模式不能真实发送")
    s = mail_settings()
    if not smtp_configured(s):
        raise MailboxError("未配置 SMTP，无法发送；可以先存草稿再到邮箱里发送")
    thread = get_thread(thread_id)
    msg = build_reply(thread, subject, body)
    try:
        server = _smtp(s)
        try:
            server.send_message(msg)
        finally:
            server.quit()
    except (OSError, smtplib.SMTPException) as exc:
        raise MailboxError(f"发送失败：{_explain(exc)}") from exc
    return {"mode": "smtp", "to": msg["To"], "subject": subject, "message_id": msg["Message-ID"]}


def get_thread(thread_id: str) -> dict:
    with _lock:
        if not _threads:
            sync()
        thread = _threads.get(thread_id)
    if not thread:
        raise MailboxError("找不到该邮件会话，请先同步")
    return thread


def last_inbound(thread: dict) -> dict:
    inbound = [m for m in thread["messages"] if not m["outbound"]]
    if not inbound:
        raise MailboxError("该会话中没有买家来信")
    return inbound[-1]


def build_reply(thread: dict, subject: str, body: str) -> EmailMessage:
    original = last_inbound(thread)
    own = own_address()
    msg = EmailMessage()
    msg["From"] = own
    msg["To"] = original["from_addr"]
    msg["Subject"] = subject
    msg["Date"] = formatdate(localtime=True)
    msg["Message-ID"] = make_msgid(domain=own.split("@")[-1])
    msg["In-Reply-To"] = original["message_id"]
    msg["References"] = " ".join(original["references"] + [original["message_id"]])
    msg["X-TradeTwin"] = "draft; synthetic estimates; human review required"
    msg.set_content(body)
    return msg


def _find_drafts(imap, s: dict | None = None) -> str:
    configured = (s or mail_settings())["drafts_folder"]
    if configured:
        return configured
    typ, lines = imap.list()
    for raw in lines or []:
        line = raw.decode("utf-8", "replace") if isinstance(raw, bytes) else str(raw)
        m = LIST_LINE.search(line)
        if m and "\\drafts" in m.group("flags").lower():
            return m.group("name").strip().strip('"')
    for name in DRAFT_CANDIDATES:
        typ, _ = imap.select(f'"{name}"', readonly=True)
        if typ == "OK":
            return name
    raise MailboxError("没有找到草稿箱，请在 .env 中设置 MAIL_DRAFTS_FOLDER")


def save_draft(thread_id: str, subject: str, body: str) -> dict:
    thread = get_thread(thread_id)
    msg = build_reply(thread, subject, body)
    if mode() == "offline":
        outbox = RUNTIME_DIR / "outbox"
        outbox.mkdir(parents=True, exist_ok=True)
        path = outbox / f"{time.strftime('%Y%m%d-%H%M%S')}-{thread_id}.eml"
        path.write_bytes(msg.as_bytes())
        return {"mode": "offline", "saved_to": str(path), "to": msg["To"], "subject": subject}
    imap = _connect()
    try:
        folder = _find_drafts(imap)
        typ, data = imap.append(f'"{folder}"', r"(\Draft)", imaplib.Time2Internaldate(time.time()), msg.as_bytes())
        if typ != "OK":
            raise MailboxError(f"写入草稿箱失败：{data}")
        return {"mode": "imap", "saved_to": folder, "to": msg["To"], "subject": subject}
    except (OSError, imaplib.IMAP4.error) as exc:
        raise MailboxError(f"写入草稿箱失败：{exc}") from exc
    finally:
        try:
            imap.logout()
        except imaplib.IMAP4.error:
            pass


def simulate_followup(thread_id: str) -> dict:
    if mode() != "offline":
        raise MailboxError("只有离线演示模式可以模拟买家回信")
    thread = get_thread(thread_id)
    ids = {m["message_id"] for m in thread["messages"]}
    released = _released()
    for p in sorted((SAMPLES_DIR / "followups").glob("*.eml")):
        if p.name in released:
            continue
        mail = parse_message(p.read_bytes())
        if mail["in_reply_to"] in ids or ids.intersection(mail["references"]):
            released.append(p.name)
            _offline_state_path().write_text(json.dumps(released), encoding="utf-8")
            sync()
            return {"released": p.name, "subject": mail["subject"]}
    raise MailboxError("该会话没有更多预置的买家回信")


def reset_offline() -> None:
    path = _offline_state_path()
    if path.exists():
        path.unlink()
    sync()

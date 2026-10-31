"""HTTP 入口：网页工作台、邮箱接入和浏览器插件共用同一套 API。"""

import re

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from . import __version__, coverage, llm, mailbox, pipeline, store, workflow2
from .config import MAIL_FIELDS, STATIC_DIR, clear_mail_settings, mail_settings, save_mail_settings
from .knowledge import get_kb

app = FastAPI(title="TradeTwin 贸链通", version=__version__)
app.add_middleware(
    CORSMiddleware,
    allow_origin_regex=r"^(chrome-extension://.*|moz-extension://.*|https?://(localhost|127\.0\.0\.1)(:\d+)?)$",
    allow_methods=["GET", "POST"],
    allow_headers=["Content-Type"],
)
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


class AnalyzeIn(BaseModel):
    text: str = Field(..., max_length=20000)
    session_id: str | None = None
    channel: str = "email"
    buyer_name: str | None = None
    subject: str | None = None
    languages: list[str] | None = None
    source: str = "manual"


class InstructIn(BaseModel):
    session_id: str
    instruction: str = Field(..., max_length=2000)


class CheckIn(BaseModel):
    text: str = Field(..., max_length=20000)
    session_id: str | None = None
    channel: str | None = None


class ThreadIn(BaseModel):
    thread_id: str


class DraftIn(BaseModel):
    thread_id: str
    language: str = "en"
    subject: str | None = None
    body: str | None = Field(None, max_length=20000)


HOST = r"^[A-Za-z0-9.-]*$"


class MailSettingsIn(BaseModel):
    imap_host: str = Field("", pattern=HOST, max_length=200)
    imap_port: int = Field(993, ge=1, le=65535)
    user: str = Field("", max_length=200)
    password: str = Field("", max_length=200)
    drafts_folder: str = Field("", max_length=200)
    signature: str = Field("", max_length=500)


def _merged_settings(body: MailSettingsIn) -> dict:
    current = mail_settings()
    data = {k: (v.strip() if isinstance(v, str) else v) for k, v in body.model_dump().items()}
    if not data["password"]:
        data["password"] = current["password"]
    return {**current, **data}


LOCAL_ORIGIN = re.compile(r"^https?://(localhost|127\.0\.0\.1)(:\d+)?$")


def _local_only(request: Request) -> None:
    origin = request.headers.get("origin")
    if origin and not LOCAL_ORIGIN.match(origin):
        raise HTTPException(403, "邮箱设置只能在本机工作台中修改")


def _public_settings(s: dict) -> dict:
    return {**{k: v for k, v in s.items() if k != "password"}, "has_password": bool(s["password"])}


def _pipeline_call(fn, *args, **kwargs):
    try:
        return fn(*args, **kwargs)
    except pipeline.PipelineError as exc:
        raise HTTPException(400, str(exc)) from exc


def _mail_call(fn, *args, **kwargs):
    try:
        return fn(*args, **kwargs)
    except mailbox.MailboxError as exc:
        raise HTTPException(502 if mailbox.mode() == "imap" else 400, str(exc)) from exc


@app.get("/")
def index():
    return FileResponse(STATIC_DIR / "index.html")


@app.get("/api/health")
def health():
    kb = get_kb()
    try:
        env = workflow2.envelope()
        wf2 = {"provider": workflow2.provider_name(), "ok": True, "rule_version": env.get("rule_version"),
               "coverage": env["coverage"]}
    except workflow2.Workflow2Error as exc:
        wf2 = {"provider": workflow2.provider_name(), "ok": False, "error": str(exc)}
    return {
        "ok": True,
        "version": __version__,
        "llm": llm.model_name(),
        "llm_configured": llm.configured(),
        "mail": mailbox.status(),
        "baseline": pipeline.baseline_view(kb),
        "workflow2": wf2,
    }


@app.get("/api/workflow2/envelope")
def wf2_reference_envelope():
    """工作流二的参考实现（本地规则），供队友对照契约联调。"""
    return coverage.contract_envelope(get_kb())


@app.post("/api/workflow2/evaluate")
def wf2_reference_evaluate(body: dict):
    if body.get("contract_version") != coverage.CONTRACT_VERSION:
        raise HTTPException(400, f"contract_version 应为 {coverage.CONTRACT_VERSION}")
    return coverage.contract_evaluate(body, get_kb())


@app.post("/api/analyze")
def analyze(body: AnalyzeIn):
    return _pipeline_call(pipeline.analyze_message, body.text, body.session_id, body.channel,
                          body.buyer_name, body.subject, body.languages, body.source)


@app.post("/api/instruct")
def instruct(body: InstructIn):
    return _pipeline_call(pipeline.apply_instruction, body.session_id, body.instruction)


@app.post("/api/check")
def check(body: CheckIn):
    return pipeline.check_reply(body.text, body.session_id, body.channel)


@app.get("/api/session/{session_id}")
def session(session_id: str):
    data = pipeline.get_session(session_id)
    if not data:
        raise HTTPException(404, "会话不存在")
    return data


@app.get("/api/mail/threads")
def mail_threads(refresh: bool = False):
    threads = _mail_call(mailbox.sync) if refresh or not mailbox.summaries() else mailbox.summaries()
    for t in threads:
        s = store.load(t["thread_id"])
        last = (s or {}).get("last_result") or {}
        analyzed = last.get("input", {}).get("source") == "email:" + t["last_message_id"]
        t["analysis"] = {"status": last.get("status"), "round": last.get("round"), "up_to_date": analyzed} if s else None
    return {"status": mailbox.status(), "threads": threads}


@app.get("/api/mail/thread/{thread_id}")
def mail_thread(thread_id: str):
    thread = _mail_call(mailbox.get_thread, thread_id)
    return {**thread, "messages": [{**m, "body_clean": mailbox.strip_quoted(m["body"])} for m in thread["messages"]]}


@app.post("/api/mail/analyze")
def mail_analyze(body: ThreadIn):
    thread = _mail_call(mailbox.get_thread, body.thread_id)
    mail = _mail_call(mailbox.last_inbound, thread)
    text = mailbox.strip_quoted(mail["body"]) or mail["body"]
    return _pipeline_call(pipeline.analyze_message, text, thread["thread_id"], "email",
                          mail["from_name"] or None, mail["subject"], None, "email:" + mail["message_id"])


@app.post("/api/mail/draft")
def mail_draft(body: DraftIn):
    subject, text = body.subject, body.body
    if not text:
        data = store.load(body.thread_id)
        reply = ((data or {}).get("last_result") or {}).get("replies", {}).get(body.language)
        if not reply:
            raise HTTPException(400, "该会话还没有生成这个语言的回复")
        subject, text = subject or reply["subject"], reply["body"]
    check_result = pipeline.check_reply(text, body.thread_id, "email")
    if check_result["level"] == "red":
        raise HTTPException(409, {"message": "回复存在高风险问题，修改后再存草稿", "check": check_result})
    thread = _mail_call(mailbox.get_thread, body.thread_id)
    subject = subject or "Re: " + thread["subject"]
    saved = _mail_call(mailbox.save_draft, body.thread_id, subject, text)
    return {**saved, "check": check_result}


@app.get("/api/settings/mail")
def get_mail_settings(request: Request):
    _local_only(request)
    return {"settings": _public_settings(mail_settings()), "status": mailbox.status()}


@app.post("/api/settings/mail/test")
def test_mail_settings(body: MailSettingsIn, request: Request):
    _local_only(request)
    return mailbox.test_connection(_merged_settings(body))


@app.post("/api/settings/mail")
def put_mail_settings(body: MailSettingsIn, request: Request):
    _local_only(request)
    merged = _merged_settings(body)
    if not (merged["imap_host"] and merged["user"] and merged["password"]):
        raise HTTPException(400, "IMAP 服务器、邮箱账号和授权码都要填写")
    result = mailbox.test_connection(merged)
    if not result["imap"]["ok"]:
        raise HTTPException(400, {"message": result["imap"]["message"], "test": result})
    if not result["imap"].get("drafts") and not merged["drafts_folder"]:
        result["imap"]["warning"] = "没有自动找到草稿箱，存草稿时可能失败，可手动填写草稿箱名称"
    save_mail_settings({k: merged[k] for k in MAIL_FIELDS})
    mailbox.invalidate()
    try:
        mailbox.sync()
    except mailbox.MailboxError:
        pass
    return {"ok": True, "test": result, "settings": _public_settings(mail_settings()), "status": mailbox.status()}


@app.post("/api/settings/mail/clear")
def reset_mail_settings(request: Request):
    _local_only(request)
    clear_mail_settings()
    mailbox.invalidate()
    return {"ok": True, "settings": _public_settings(mail_settings()), "status": mailbox.status()}


@app.post("/api/mail/simulate-reply")
def mail_simulate(body: ThreadIn):
    return _mail_call(mailbox.simulate_followup, body.thread_id)


@app.post("/api/mail/reset")
def mail_reset():
    if mailbox.mode() != "offline":
        raise HTTPException(400, "只有离线演示模式可以重置")
    _mail_call(mailbox.reset_offline)
    return {"ok": True, "threads": mailbox.summaries()}

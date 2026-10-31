import email
from email import policy
from email.message import EmailMessage

import pytest
from fastapi.testclient import TestClient

from tradetwin import config, mailbox, store
from tradetwin.server import app


def make_mail(message_id="<buyer-1@example.com>", sender="buyer@example.com",
              recipient="sales@example.com", subject="RFQ", references=(),
              in_reply_to=None, cc=None, day=1):
    msg = EmailMessage()
    msg["From"] = sender
    msg["To"] = recipient
    msg["Subject"] = subject
    msg["Date"] = f"Thu, {day:02d} Oct 2026 12:00:00 +0000"
    if message_id:
        msg["Message-ID"] = message_id
    if references:
        msg["References"] = " ".join(references)
    if in_reply_to:
        msg["In-Reply-To"] = in_reply_to
    if cc:
        msg["Cc"] = cc
    msg.set_content("Please review the updated specification.")
    return msg.as_bytes()


class FakeIMAP:
    """Model server flags so a non-PEEK fetch exposes a read-state mutation."""

    def __init__(self, messages):
        self.messages = messages
        self.flags = {str(n).encode(): set() for n in range(1, len(messages) + 1)}
        self.calls = []
        self.drafts = []

    def select(self, folder, readonly=False):
        self.calls.append(("select", folder, readonly))
        return "OK", [str(len(self.messages)).encode()]

    def search(self, charset, criteria):
        self.calls.append(("search", charset, criteria))
        return "OK", [b" ".join(self.flags)]

    def fetch(self, number, query):
        self.calls.append(("fetch", number, query))
        if "PEEK" not in query:
            self.flags[number].add(r"\Seen")
        return "OK", [(b"RFC822", self.messages[int(number) - 1]), b")"]

    def store(self, *args):
        self.calls.append(("STORE", *args))
        raise AssertionError("Intake must not mutate flags")

    def list(self):
        return "OK", [b'(\\Drafts) "/" "Drafts"']

    def append(self, folder, flags, date, raw):
        self.calls.append(("append", folder, flags))
        self.drafts.append(raw)
        return "OK", [b"saved"]

    def logout(self):
        self.calls.append(("logout",))
        return "BYE", []


@pytest.fixture(autouse=True)
def isolated_mailbox(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "RUNTIME_DIR", tmp_path)
    monkeypatch.setattr(mailbox, "RUNTIME_DIR", tmp_path)
    monkeypatch.setattr(store, "RUNTIME_DIR", tmp_path)
    mailbox.invalidate()
    yield
    mailbox.invalidate()


def use_imap(monkeypatch, fake, limit=30):
    config.save_mail_settings({"imap_host": "imap.example.com", "user": "sales@example.com",
                               "password": "test", "drafts_folder": "Drafts"})
    monkeypatch.setenv("MAIL_FETCH_LIMIT", str(limit))
    monkeypatch.setattr(mailbox, "_connect", lambda *args: fake)


def test_missing_message_id_is_stable_for_the_same_raw_message():
    raw = make_mail(message_id=None)
    assert mailbox.parse_message(raw)["message_id"] == mailbox.parse_message(raw)["message_id"]
    assert mailbox.parse_message(raw)["message_id"] != mailbox.parse_message(raw + b"changed")["message_id"]


def test_recipients_are_normalized_for_outbound_association():
    mail = mailbox.parse_message(make_mail(recipient="Buyer <BUYER@example.com>", cc="Other <OTHER@example.com>"))
    assert mail["to_addrs"] == ["buyer@example.com"]
    assert mail["cc_addrs"] == ["other@example.com"]


def test_same_subject_from_two_buyers_does_not_merge():
    mails = [mailbox.parse_message(make_mail(message_id=f"<{name}@x>", sender=f"{name}@example.com"))
             for name in ("a", "b")]
    assert len(mailbox.group_threads(mails, "sales@example.com")) == 2


def test_outbound_subject_fallback_uses_the_buyer_recipient():
    mails = [mailbox.parse_message(make_mail()), mailbox.parse_message(make_mail(
        message_id="<sales-1@example.com>", sender="sales@example.com",
        recipient="buyer@example.com", subject="Re: RFQ", day=2))]
    thread, = mailbox.group_threads(mails, "sales@example.com").values()
    assert thread["buyer_addr"] == "buyer@example.com"
    assert [m["outbound"] for m in thread["messages"]] == [False, True]


def test_header_links_associate_changed_subject_even_when_root_is_missing():
    first = mailbox.parse_message(make_mail(message_id="<one@x>", references=["<root@x>"], subject="First"))
    second = mailbox.parse_message(make_mail(message_id="<two@x>", references=["<root@x>"], subject="Changed", day=2))
    thread, = mailbox.group_threads([second, first], "sales@example.com").values()
    assert len(thread["messages"]) == 2


def test_reply_headers_keep_the_original_thread():
    thread, = mailbox.group_threads([mailbox.parse_message(make_mail(
        references=["<root@example.com>"]))], "sales@example.com").values()
    reply = mailbox.build_reply(thread, "Re: RFQ", "Draft")
    assert reply["In-Reply-To"] == "<buyer-1@example.com>"
    assert reply["References"] == "<root@example.com> <buyer-1@example.com>"


def test_duplicate_fetch_does_not_duplicate_messages():
    mail = mailbox.parse_message(make_mail())
    thread, = mailbox.group_threads([mail, dict(mail)], "sales@example.com").values()
    assert len(thread["messages"]) == 1


def test_fetch_preserves_unread_flags_and_uses_peek(monkeypatch):
    fake = FakeIMAP([make_mail()])
    use_imap(monkeypatch, fake)
    assert len(mailbox._fetch_imap()) == 1
    assert ("select", "INBOX", True) in fake.calls
    assert ("fetch", b"1", "(BODY.PEEK[])") in fake.calls
    assert fake.flags[b"1"] == set()
    assert not any(call[0].upper() == "STORE" for call in fake.calls)


@pytest.mark.parametrize("headers", [{"references": ["<buyer-1@example.com>"]}, {},
                                     {"in_reply_to": "<buyer-1@example.com>", "subject": "New subject"}])
def test_newer_window_retains_session_after_restart(monkeypatch, headers):
    fake = FakeIMAP([make_mail()])
    use_imap(monkeypatch, fake, limit=1)
    original, = mailbox.sync()
    tid = original["thread_id"]
    store.save({"session_id": tid, "round": 2})
    fake.messages.append(make_mail(message_id="<new@example.com>", day=2, **headers))
    fake.flags[b"2"] = set()
    mailbox.invalidate()  # Drop all process-local thread state, retaining runtime files.
    newer, = mailbox.sync()
    assert newer["thread_id"] == tid
    assert store.load(newer["thread_id"])["round"] == 2
    assert newer["last_message_id"] == "<new@example.com>"


def test_draft_appends_reply_headers_without_sending(monkeypatch):
    fake = FakeIMAP([make_mail(references=["<root@example.com>"])])
    use_imap(monkeypatch, fake)
    thread, = mailbox.sync()
    response = TestClient(app).post("/api/mail/draft", json={
        "thread_id": thread["thread_id"], "subject": "Re: RFQ", "body": "Draft for review."})
    assert response.status_code == 200, response.text
    assert response.json()["mode"] == "imap"
    reply = email.message_from_bytes(fake.drafts[0], policy=policy.default)
    assert reply["To"] == "buyer@example.com"
    assert reply["In-Reply-To"] == "<buyer-1@example.com>"
    assert reply["References"] == "<root@example.com> <buyer-1@example.com>"
    assert ("append", '"Drafts"', r"(\Draft)") in fake.calls
    assert fake.flags[b"1"] == set()


def test_thread_identity_does_not_cross_mailbox_accounts(monkeypatch):
    fake = FakeIMAP([make_mail()])
    use_imap(monkeypatch, fake)
    first, = mailbox.sync()
    config.save_mail_settings({"imap_host": "imap.example.com", "user": "other@example.com", "password": "test"})
    mailbox.invalidate()
    second, = mailbox.sync()
    assert first["thread_id"] != second["thread_id"]


def test_offline_reset_starts_fresh_identity_and_preserves_previous_session(verified_workflow2):
    client = TestClient(app)
    original = client.get("/api/mail/threads?refresh=true").json()["threads"][0]
    tid = original["thread_id"]
    first = client.post("/api/mail/analyze", json={"thread_id": tid})
    assert first.status_code == 200, first.text
    previous = first.json()
    advanced = client.post("/api/instruct", json={"session_id": tid, "instruction": "只要德语"})
    assert advanced.status_code == 200, advanced.text
    reset = client.post("/api/mail/reset")
    assert reset.status_code == 200, reset.text
    new = next(thread for thread in reset.json()["threads"] if thread["subject"] == original["subject"])
    assert new["thread_id"] != tid
    restarted = client.post("/api/mail/analyze", json={"thread_id": new["thread_id"]})
    assert restarted.status_code == 200, restarted.text
    assert restarted.json()["round"] == 1
    assert restarted.json()["session_id"] != previous["session_id"]
    assert store.load(tid)["last_result"]["run_id"] == advanced.json()["run_id"]
    mailbox.invalidate()
    reloaded = client.get("/api/mail/threads?refresh=true").json()["threads"]
    assert next(thread for thread in reloaded if thread["subject"] == original["subject"])["thread_id"] == new["thread_id"]


def test_offline_reset_cannot_change_live_mailbox_identity(monkeypatch):
    fake = FakeIMAP([make_mail()])
    use_imap(monkeypatch, fake)
    first, = mailbox.sync()
    response = TestClient(app).post("/api/mail/reset")
    assert response.status_code == 400
    mailbox.invalidate()
    second, = mailbox.sync()
    assert second["thread_id"] == first["thread_id"]

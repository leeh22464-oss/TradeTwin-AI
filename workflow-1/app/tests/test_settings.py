import json

import pytest
from fastapi.testclient import TestClient

from tradetwin import config, mailbox
from tradetwin.server import app

client = TestClient(app)
GOOD = {"imap_host": "imap.example.com", "imap_port": 993, "user": "sales@example.com", "password": "auth-code-123",
        "drafts_folder": "", "signature": "Sales Team", "smtp_host": "smtp.example.com", "smtp_port": 465,
        "smtp_security": "ssl"}


@pytest.fixture(autouse=True)
def clean():
    config.clear_mail_settings()
    mailbox.invalidate()
    yield
    config.clear_mail_settings()
    mailbox.invalidate()


def test_failed_connection_is_not_saved():
    bad = {**GOOD, "imap_host": "127.0.0.1", "imap_port": 9}
    resp = client.post("/api/settings/mail", json=bad)
    assert resp.status_code == 400
    assert not config.mail_settings_path().exists()
    assert mailbox.mode() == "offline"


def test_saved_settings_never_return_password(monkeypatch):
    monkeypatch.setattr(mailbox, "test_connection", lambda s: {"imap": {"ok": True, "message": "ok", "drafts": "Drafts"}})
    monkeypatch.setattr(mailbox, "sync", lambda: [])
    assert client.post("/api/settings/mail", json=GOOD).status_code == 200
    assert mailbox.mode() == "imap"

    data = client.get("/api/settings/mail").json()["settings"]
    assert "password" not in data and data["has_password"] and data["source"] == "ui"

    kept = client.post("/api/settings/mail", json={**GOOD, "password": "", "signature": "New"})
    assert kept.status_code == 200
    assert config.mail_settings()["password"] == "auth-code-123"
    assert config.mail_settings()["signature"] == "New"

    assert client.post("/api/settings/mail/clear").status_code == 200
    assert mailbox.mode() == "offline"


def test_settings_rejected_from_foreign_origin():
    headers = {"Origin": "chrome-extension://someotherextension"}
    assert client.get("/api/settings/mail", headers=headers).status_code == 403
    assert client.post("/api/settings/mail", json=GOOD, headers=headers).status_code == 403


def test_invalid_host_rejected():
    assert client.post("/api/settings/mail/test", json={**GOOD, "imap_host": "evil host/../"}).status_code == 422


def test_application_has_no_mail_send_endpoint():
    resp = client.post("/api/mail/send", json={"thread_id": "anything", "subject": "Re: x", "body": "Draft"})
    assert resp.status_code == 404


def test_legacy_smtp_settings_are_ignored(monkeypatch):
    path = config.mail_settings_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({**GOOD, "smtp_port": "invalid legacy port"}), encoding="utf-8")
    monkeypatch.setenv("MAIL_SMTP_PORT", "invalid legacy env port")
    data = client.get("/api/settings/mail")
    assert data.status_code == 200
    settings = data.json()["settings"]
    assert settings["imap_host"] == "imap.example.com"
    assert settings["has_password"]
    assert not any(k.startswith("smtp") for k in settings)
    config.save_mail_settings(GOOD)
    assert not any(k.startswith("smtp") for k in json.loads(path.read_text(encoding="utf-8")))

import os
import sys
import tempfile
from pathlib import Path

os.environ["TRADETWIN_RUNTIME_DIR"] = tempfile.mkdtemp(prefix="tradetwin-test-")
for key in ("LLM_BASE_URL", "LLM_API_KEY", "LLM_MODEL", "MAIL_IMAP_HOST", "MAIL_USER", "MAIL_PASSWORD"):
    os.environ[key] = ""
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))
os.environ["WORKFLOW2_MODE"] = "local"

import pytest

import fake_wf2
from tradetwin import workflow2


@pytest.fixture
def teammate(monkeypatch):
    monkeypatch.setenv("WORKFLOW2_MODE", "python")
    monkeypatch.setenv("WORKFLOW2_MODULE", "fake_wf2")
    workflow2._cache.clear()
    fake_wf2.BEHAVIOUR.update(mode="ok", evidence_version="evidence-v1")
    yield fake_wf2.BEHAVIOUR
    workflow2._cache.clear()

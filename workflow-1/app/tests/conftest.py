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

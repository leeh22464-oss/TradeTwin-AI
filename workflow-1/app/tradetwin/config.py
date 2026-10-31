import json
import os
from pathlib import Path

PACKAGE_DIR = Path(__file__).resolve().parent
APP_DIR = PACKAGE_DIR.parent
PROJECT_ROOT = APP_DIR.parent


def _load_env_file(path: Path) -> None:
    if not path.exists():
        return
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


_load_env_file(APP_DIR / ".env")


def env(name: str, default: str = "") -> str:
    return os.environ.get(name, default).strip()


KB_DIR = Path(env("TRADETWIN_KB_DIR") or PROJECT_ROOT / "knowledge-base")
DATA_DIR = PACKAGE_DIR / "data"
STATIC_DIR = PACKAGE_DIR / "static"
SAMPLES_DIR = PACKAGE_DIR / "samples"
RUNTIME_DIR = Path(env("TRADETWIN_RUNTIME_DIR") or APP_DIR / "runtime")


def llm_settings() -> dict:
    return {
        "base_url": env("LLM_BASE_URL").rstrip("/"),
        "api_key": env("LLM_API_KEY"),
        "model": env("LLM_MODEL"),
        "timeout": float(env("LLM_TIMEOUT", "40")),
    }


MAIL_FIELDS = ("imap_host", "imap_port", "user", "password", "drafts_folder", "signature")


def mail_settings_path() -> Path:
    return RUNTIME_DIR / "mail-settings.json"


def saved_mail_settings() -> dict:
    path = mail_settings_path()
    if not path.exists():
        return {}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return {k: v for k, v in data.items() if k in MAIL_FIELDS}


def save_mail_settings(data: dict) -> None:
    path = mail_settings_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    clean = {k: data[k] for k in MAIL_FIELDS if k in data}
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(clean, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(path)


def clear_mail_settings() -> None:
    path = mail_settings_path()
    if path.exists():
        path.unlink()


def mail_settings() -> dict:
    saved = saved_mail_settings()
    source = "ui" if saved else ("env" if env("MAIL_IMAP_HOST") else "none")
    pick = (lambda key, name, default="": str(saved[key]).strip() if saved and key in saved
            else env(name, default))
    return {
        "source": source,
        "imap_host": pick("imap_host", "MAIL_IMAP_HOST"),
        "imap_port": int(pick("imap_port", "MAIL_IMAP_PORT", "993") or 993),
        "user": pick("user", "MAIL_USER"),
        "password": pick("password", "MAIL_PASSWORD"),
        "drafts_folder": pick("drafts_folder", "MAIL_DRAFTS_FOLDER"),
        "fetch_limit": int(env("MAIL_FETCH_LIMIT", "30")),
        "signature": pick("signature", "MAIL_SIGNATURE", "NordLuma Lighting Sales Team") or "NordLuma Lighting Sales Team",
    }

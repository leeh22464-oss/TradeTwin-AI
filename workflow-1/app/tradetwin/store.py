"""会话状态的本地 JSON 存储；同一会话的多轮结果和幂等缓存都放在这里。"""

import json
import re
import threading
import uuid

from .config import RUNTIME_DIR

_lock = threading.RLock()


def _dir():
    path = RUNTIME_DIR / "sessions"
    path.mkdir(parents=True, exist_ok=True)
    return path


def safe_id(session_id: str) -> str:
    return re.sub(r"[^A-Za-z0-9_.-]", "_", session_id)[:120]


def new_id() -> str:
    return "S-" + uuid.uuid4().hex[:10]


def load(session_id: str | None) -> dict | None:
    if not session_id:
        return None
    path = _dir() / f"{safe_id(session_id)}.json"
    with _lock:
        if not path.exists():
            return None
        return json.loads(path.read_text(encoding="utf-8"))


def delete(session_id: str) -> None:
    path = _dir() / f"{safe_id(session_id)}.json"
    with _lock:
        if path.exists():
            path.unlink()


def save(session: dict) -> None:
    path = _dir() / f"{safe_id(session['session_id'])}.json"
    with _lock:
        tmp = path.with_suffix(".tmp")
        tmp.write_text(json.dumps(session, ensure_ascii=False, indent=2), encoding="utf-8")
        tmp.replace(path)

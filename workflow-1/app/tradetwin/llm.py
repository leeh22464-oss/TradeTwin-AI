"""OpenAI 兼容接口的最小封装；未配置或调用失败时返回 None，由调用方走规则/模板兜底。"""

import json
import logging

import httpx

from .config import llm_settings

log = logging.getLogger(__name__)


def configured() -> bool:
    s = llm_settings()
    return bool(s["base_url"] and s["api_key"] and s["model"])


def model_name() -> str:
    return llm_settings()["model"] if configured() else "rule-template"


def chat_json(system: str, user: str, temperature: float = 0.2) -> dict | None:
    if not configured():
        return None
    s = llm_settings()
    payload = {
        "model": s["model"],
        "temperature": temperature,
        "response_format": {"type": "json_object"},
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ],
    }
    headers = {"Authorization": f"Bearer {s['api_key']}"}
    last_error = None
    for _ in range(2):
        try:
            resp = httpx.post(f"{s['base_url']}/chat/completions", json=payload,
                              headers=headers, timeout=s["timeout"])
            resp.raise_for_status()
            content = resp.json()["choices"][0]["message"]["content"]
            return json.loads(_strip_fence(content))
        except (httpx.HTTPError, KeyError, IndexError, json.JSONDecodeError) as exc:
            last_error = exc
    log.warning("LLM call failed, falling back: %s", last_error)
    return None


def _strip_fence(text: str) -> str:
    text = text.strip()
    if text.startswith("```"):
        text = text.split("\n", 1)[1] if "\n" in text else text
        text = text.rsplit("```", 1)[0]
    return text.strip()

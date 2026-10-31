"""工作流一 → 工作流二的唯一接入点（契约 tradetwin.wf2.v1，说明见 app/docs/workflow2-contract.md）。

WORKFLOW2_MODE:
  local  —— 本仓库的参考实现 coverage.py（默认，离线可跑）
  python —— 队友的 Python 模块，WORKFLOW2_MODULE=包.模块，需提供 envelope() 和 evaluate(request)
  http   —— 队友的服务，WORKFLOW2_URL，需提供 GET /envelope 和 POST /evaluate
工作流二不可用或返回不合契约时抛 Workflow2Error，工作流一只追问、不报价，不用本地数据冒充。
"""

import importlib
import time
import uuid

import httpx

from . import coverage
from .config import env
from .knowledge import get_kb

CONTRACT_VERSION = coverage.CONTRACT_VERSION
STATUSES = {"COVERED", "NEEDS_RETEST", "DOCUMENT_UPDATE", "MANUAL_REVIEW", "NOT_ENOUGH_EVIDENCE"}
SCOPE = {"market": "EU", "product_scope": "indoor_fixed_led_luminaire"}
_cache: dict = {}


class Workflow2Error(Exception):
    pass


def settings() -> dict:
    return {
        "mode": env("WORKFLOW2_MODE", "local").lower(),
        "module": env("WORKFLOW2_MODULE"),
        "url": env("WORKFLOW2_URL").rstrip("/"),
        "timeout": float(env("WORKFLOW2_TIMEOUT", "15")),
    }


def provider_name() -> str:
    s = settings()
    if s["mode"] == "python":
        return "python:" + s["module"]
    if s["mode"] == "http":
        return "http:" + s["url"]
    return "local:reference"


def _call(op: str, payload: dict | None = None) -> dict:
    s = settings()
    try:
        if s["mode"] == "local":
            kb = get_kb()
            return coverage.contract_envelope(kb) if op == "envelope" else coverage.contract_evaluate(payload, kb)
        if s["mode"] == "python":
            if not s["module"]:
                raise Workflow2Error("WORKFLOW2_MODE=python 但未设置 WORKFLOW2_MODULE")
            module = importlib.import_module(s["module"])
            return module.envelope() if op == "envelope" else module.evaluate(payload)
        if s["mode"] == "http":
            if not s["url"]:
                raise Workflow2Error("WORKFLOW2_MODE=http 但未设置 WORKFLOW2_URL")
            with httpx.Client(timeout=s["timeout"]) as client:
                resp = client.get(s["url"] + "/envelope") if op == "envelope" else client.post(s["url"] + "/evaluate", json=payload)
                resp.raise_for_status()
                return resp.json()
        raise Workflow2Error(f"未知的 WORKFLOW2_MODE：{s['mode']}")
    except Workflow2Error:
        raise
    except Exception as exc:
        raise Workflow2Error(f"工作流二（{provider_name()}）调用失败：{exc}") from exc


def _require(cond: bool, problems: list, message: str) -> bool:
    if not cond:
        problems.append(message)
    return cond


def _num(value) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and value >= 0


def validate_envelope(data: dict) -> dict:
    problems: list[str] = []
    _require(isinstance(data, dict), problems, "envelope 不是对象")
    if not problems:
        _require(data.get("contract_version") == CONTRACT_VERSION, problems, f"contract_version 应为 {CONTRACT_VERSION}")
        cov = data.get("coverage") or {}
        rng = cov.get("power_range_w") or {}
        _require(_num(rng.get("min")) and _num(rng.get("max")), problems, "coverage.power_range_w.min/max 缺失")
        _require(bool(cov.get("ip_rating")), problems, "coverage.ip_rating 缺失")
        _require(bool(cov.get("driver")), problems, "coverage.driver 缺失")
        _require(isinstance(data.get("product"), dict), problems, "product 缺失")
    if problems:
        raise Workflow2Error("工作流二 envelope 不符合契约：" + "；".join(problems))
    return data


def _normalize_result(raw: dict, config: dict, problems: list, warnings: list) -> dict:
    cid = raw.get("config_id")
    findings = []
    for f in raw.get("findings") or []:
        status = f.get("status")
        if status not in STATUSES:
            warnings.append(f"{cid}：未知结论 {status!r}，按 MANUAL_REVIEW 处理")
            status = "MANUAL_REVIEW"
        evidence = [e for e in f.get("evidence") or [] if e.get("document_id") and e.get("page") is not None and e.get("quote")]
        if status == "COVERED" and not evidence:
            warnings.append(f"{cid}：{f.get('item')} 判为覆盖但没有页码证据，降为 MANUAL_REVIEW")
            status = "MANUAL_REVIEW"
        findings.append({
            "item_key": f.get("item_key") or f.get("item"),
            "item": f.get("item") or f.get("item_key"),
            "status": status,
            "reason": f.get("reason", ""),
            "evidence": evidence,
            "rule_refs": list(f.get("rule_refs") or []),
        })
    retests = []
    for r in raw.get("retest_items") or []:
        key = r.get("test_key")
        _require(bool(key), problems, f"{cid}：retest_items 缺少 test_key")
        _require(_num(r.get("cost_eur")) and _num(r.get("lab_days")), problems, f"{cid}：{key} 缺少 cost_eur/lab_days")
        retests.append({"test_key": key, "name": r.get("name") or {}, "cost_eur": r.get("cost_eur"), "lab_days": r.get("lab_days")})
    _require(_num(raw.get("estimated_cost_eur")), problems, f"{cid}：estimated_cost_eur 缺失或为负")
    _require(_num(raw.get("estimated_days")), problems, f"{cid}：estimated_days 缺失或为负")
    _require(raw.get("synthetic") is not None and raw.get("human_confirmed") is not None, problems,
             f"{cid}：必须声明 synthetic 和 human_confirmed")

    manual = bool(raw.get("manual_review_required")) or any(
        f["status"] in ("MANUAL_REVIEW", "NOT_ENOUGH_EVIDENCE") for f in findings)
    return {
        "config": config,
        "findings": findings,
        "retest_items": [r["test_key"] for r in retests],
        "retest_details": {r["test_key"]: r for r in retests},
        "document_updates": list(raw.get("document_updates") or []),
        "incomplete": [f["item_key"] for f in findings if f["status"] == "NOT_ENOUGH_EVIDENCE"],
        "manual_review_required": manual,
        "estimated_cost_eur": raw.get("estimated_cost_eur"),
        "estimated_days": raw.get("estimated_days"),
        "days_breakdown": raw.get("days_breakdown") or {},
        "owner_actions": list(raw.get("owner_actions") or []),
        "issues": list(raw.get("issues") or []),
        "synthetic": raw.get("synthetic"),
        "human_confirmed": raw.get("human_confirmed"),
        "source_type": raw.get("source_type", "unknown"),
        "assumption_version": raw.get("assumption_version", ""),
    }


def envelope() -> dict:
    key = provider_name()
    hit = _cache.get(key)
    if hit and time.time() - hit[0] < 60:
        return hit[1]
    data = validate_envelope(_call("envelope"))
    _cache[key] = (time.time(), data)
    return data


def evaluate(configs: dict[str, dict]) -> dict:
    """configs: {config_id: {power_w, ip_rating, driver}}，值可为 None（未确认）。
    返回 {"rule_version", "provider", "warnings", "results": {config_id: 归一化结果}}。"""
    request = {
        "contract_version": CONTRACT_VERSION,
        "request_id": "WF1-" + uuid.uuid4().hex[:10],
        "scope": SCOPE,
        "configs": [{"config_id": cid, **{k: cfg.get(k) for k in ("power_w", "ip_rating", "driver")}}
                    for cid, cfg in configs.items()],
    }
    data = _call("evaluate", request)
    problems: list[str] = []
    warnings: list[str] = []
    if not isinstance(data, dict) or data.get("contract_version") != CONTRACT_VERSION:
        raise Workflow2Error(f"工作流二返回的 contract_version 不是 {CONTRACT_VERSION}")
    by_id = {r.get("config_id"): r for r in data.get("results") or [] if isinstance(r, dict)}
    results = {}
    for cid, cfg in configs.items():
        if cid not in by_id:
            problems.append(f"缺少 config_id={cid} 的结果")
            continue
        results[cid] = _normalize_result(by_id[cid], dict(cfg), problems, warnings)
    if problems:
        raise Workflow2Error("工作流二结果不符合契约：" + "；".join(problems))
    return {"rule_version": data.get("rule_version", "unknown"), "provider": provider_name(),
            "warnings": warnings, "results": results}

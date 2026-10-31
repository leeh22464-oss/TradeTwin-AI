"""工作流一 → 工作流二的唯一接入点（契约 tradetwin.wf2.v1，说明见 app/docs/workflow2-contract.md）。

WORKFLOW2_MODE:
  http   —— 队友的服务（默认，WORKFLOW2_URL）
  local  —— 本仓库的参考实现 coverage.py（显式选择的离线模式）
  python —— 队友的 Python 模块，WORKFLOW2_MODULE=包.模块，需提供 envelope() 和 evaluate(request)
  http   —— 队友的服务，WORKFLOW2_URL，需提供 GET /envelope 和 POST /evaluate
工作流二不可用或返回不合契约时抛 Workflow2Error，工作流一只追问、不报价，不用本地数据冒充。
"""

import importlib
import math
import uuid

import httpx

from . import coverage
from .config import env
from .knowledge import get_kb

CONTRACT_VERSION = coverage.CONTRACT_VERSION
STATUSES = {"COVERED", "NEEDS_RETEST", "DOCUMENT_UPDATE", "MANUAL_REVIEW", "NOT_ENOUGH_EVIDENCE"}
SCOPE = {"market": "EU", "product_scope": "indoor_fixed_led_luminaire"}
# Kept as a compatibility hook for existing fixtures. Envelopes are deliberately
# fetched on every invocation because evidence can change without a rule change.
_cache: dict = {}


class Workflow2Error(Exception):
    pass


def settings() -> dict:
    return {
        "mode": env("WORKFLOW2_MODE", "http").lower(),
        "module": env("WORKFLOW2_MODULE"),
        "url": env("WORKFLOW2_URL", "http://127.0.0.1:3001/api/workflow2").rstrip("/"),
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
            data = coverage.contract_envelope(kb) if op == "envelope" else coverage.contract_evaluate(payload, kb)
            data["evidence_version"] = data.get("evidence_version") or data.get("rule_version")
            return data
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
    return (isinstance(value, (int, float)) and not isinstance(value, bool)
            and math.isfinite(value) and value >= 0)


def _positive_page(value) -> bool:
    return isinstance(value, int) and not isinstance(value, bool) and value > 0


def validate_envelope(data: dict) -> dict:
    problems: list[str] = []
    _require(isinstance(data, dict), problems, "envelope 不是对象")
    if not problems:
        _require(data.get("contract_version") == CONTRACT_VERSION, problems, f"contract_version 应为 {CONTRACT_VERSION}")
        cov = data.get("coverage") or {}
        _require(isinstance(cov, dict), problems, "coverage 不是对象")
        rng = cov.get("power_range_w") if isinstance(cov, dict) else {}
        rng = rng or {}
        _require(isinstance(rng, dict), problems, "coverage.power_range_w 不是对象")
        if isinstance(rng, dict):
            _require(_num(rng.get("min")) and _num(rng.get("max")), problems, "coverage.power_range_w.min/max 缺失")
        _require(bool(cov.get("ip_rating")) if isinstance(cov, dict) else False, problems, "coverage.ip_rating 缺失")
        _require(bool(cov.get("driver")) if isinstance(cov, dict) else False, problems, "coverage.driver 缺失")
        _require(isinstance(data.get("product"), dict), problems, "product 缺失")
        evidence = (cov.get("evidence") or []) if isinstance(cov, dict) else []
        _require(isinstance(evidence, list), problems, "coverage.evidence 不是数组")
        for item in evidence if isinstance(evidence, list) else []:
            _require(isinstance(item, dict), problems, "coverage.evidence 项不是对象")
            if isinstance(item, dict):
                _require(bool(item.get("document_id")) and _positive_page(item.get("page"))
                         and isinstance(item.get("quote"), str) and bool(item.get("quote").strip()),
                         problems, "coverage.evidence 必须包含正整数 page 和 quote")
    if problems:
        raise Workflow2Error("工作流二 envelope 不符合契约：" + "；".join(problems))
    return data


def _normalize_result(raw: dict, config: dict, problems: list, warnings: list) -> dict:
    if not isinstance(raw, dict):
        problems.append(f"{config.get('config_id', '<unknown>')}：结果不是对象")
        return {}
    cid = raw.get("config_id")
    _require(cid == config.get("config_id", cid), problems, f"{cid}：config_id 与请求不一致")
    findings = []
    raw_findings = raw.get("findings")
    _require(isinstance(raw_findings, list), problems, f"{cid}：findings 不是数组")
    for f in raw_findings if isinstance(raw_findings, list) else []:
        _require(isinstance(f, dict), problems, f"{cid}：finding 不是对象")
        if not isinstance(f, dict):
            continue
        status = f.get("status")
        if status not in STATUSES:
            warnings.append(f"{cid}：未知结论 {status!r}，按 MANUAL_REVIEW 处理")
            status = "MANUAL_REVIEW"
        raw_evidence = f.get("evidence") or []
        _require(isinstance(raw_evidence, list), problems, f"{cid}：{f.get('item')} 的 evidence 不是数组")
        evidence = []
        for e in raw_evidence if isinstance(raw_evidence, list) else []:
            valid = (isinstance(e, dict) and bool(e.get("document_id"))
                     and _positive_page(e.get("page"))
                     and isinstance(e.get("quote"), str) and bool(e.get("quote").strip()))
            _require(valid, problems, f"{cid}：{f.get('item')} 的 evidence 页码或原文无效")
            if valid:
                evidence.append(e)
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
    raw_retests = raw.get("retest_items") or []
    _require(isinstance(raw_retests, list), problems, f"{cid}：retest_items 不是数组")
    for r in raw_retests if isinstance(raw_retests, list) else []:
        _require(isinstance(r, dict), problems, f"{cid}：retest_items 项不是对象")
        if not isinstance(r, dict):
            continue
        key = r.get("test_key")
        _require(bool(key), problems, f"{cid}：retest_items 缺少 test_key")
        _require(_num(r.get("cost_eur")) and _num(r.get("lab_days")), problems, f"{cid}：{key} 缺少 cost_eur/lab_days")
        name = r.get("name") or {}
        _require(isinstance(name, dict), problems, f"{cid}：{key} 的 name 必须是对象")
        retests.append({"test_key": key, "name": name if isinstance(name, dict) else {},
                        "cost_eur": r.get("cost_eur"), "lab_days": r.get("lab_days")})
    for field in ("estimated_cost_eur", "estimated_days"):
        _require(field in raw, problems, f"{cid}：缺少 {field}")
        _require(raw.get(field) is None or _num(raw.get(field)), problems,
                 f"{cid}：{field} 必须为有限非负数或 null")
    _require(isinstance(raw.get("synthetic"), bool) and isinstance(raw.get("human_confirmed"), bool), problems,
             f"{cid}：synthetic 和 human_confirmed 必须是布尔值")
    for field in ("document_updates", "owner_actions", "issues"):
        _require(isinstance(raw.get(field, []), list), problems, f"{cid}：{field} 必须是数组")
    owner_actions = raw.get("owner_actions") or []
    _require(all(isinstance(item, dict) for item in owner_actions), problems,
             f"{cid}：owner_actions 项必须是对象")

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
        "owner_actions": [item for item in owner_actions if isinstance(item, dict)],
        "issues": list(raw.get("issues") or []),
        "synthetic": raw.get("synthetic"),
        "human_confirmed": raw.get("human_confirmed"),
        "source_type": raw.get("source_type", "unknown"),
        "assumption_version": raw.get("assumption_version", ""),
    }


def envelope() -> dict:
    data = validate_envelope(_call("envelope"))
    if not isinstance(data.get("evidence_version"), str) or not data["evidence_version"].strip():
        raise Workflow2Error("工作流二 envelope 缺少非空 evidence_version")
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
    if data.get("request_id") != request["request_id"]:
        raise Workflow2Error("工作流二返回的 request_id 与请求不一致")
    if not isinstance(data.get("evidence_version"), str) or not data["evidence_version"].strip():
        raise Workflow2Error("工作流二 evaluate 缺少非空 evidence_version")
    raw_results = data.get("results")
    if not isinstance(raw_results, list):
        raise Workflow2Error("工作流二返回的 results 不是数组")
    ids = [r.get("config_id") if isinstance(r, dict) else None for r in raw_results]
    if any(not isinstance(cid, str) for cid in ids):
        raise Workflow2Error("工作流二结果包含无效 config_id")
    expected_ids = list(configs)
    if len(ids) != len(set(ids)):
        raise Workflow2Error("工作流二结果包含重复 config_id")
    if set(ids) != set(expected_ids):
        raise Workflow2Error("工作流二结果缺少或多出请求的 config_id")
    by_id = {r.get("config_id"): r for r in raw_results}
    results = {}
    for cid, cfg in configs.items():
        if cid not in by_id:
            problems.append(f"缺少 config_id={cid} 的结果")
            continue
        results[cid] = _normalize_result(by_id[cid], dict(cfg), problems, warnings)
    if problems:
        raise Workflow2Error("工作流二结果不符合契约：" + "；".join(problems))
    return {"request_id": request["request_id"], "rule_version": data.get("rule_version", "unknown"),
            "evidence_version": data["evidence_version"],
            "provider": provider_name(), "warnings": warnings, "results": results}

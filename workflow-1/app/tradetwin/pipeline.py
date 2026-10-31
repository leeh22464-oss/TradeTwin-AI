"""工作流一编排：理解 → 结构化 → 取代价 → 生成 → 校验，并管理多轮会话与幂等。"""

import copy
import hashlib
import json
import uuid
from datetime import datetime, timezone

from . import checker, extract, llm, options, store, workflow2, writer
from .config import mail_settings
from .knowledge import get_kb

FIELD_LABELS = {
    "power_w": "额定功率",
    "ip_rating": "防护等级",
    "driver": "驱动电源",
    "quantity": "订单数量",
    "delivery": "交期要求",
    "installation": "安装环境",
}
OWNER_LABELS = {
    "SALES": "外贸业务",
    "ENGINEERING": "产品工程",
    "QUALITY_COMPLIANCE": "品质合规",
    "LAB_PURCHASING": "采购/实验室",
}
CHANNELS = ("email", "alibaba_rfq")


class PipelineError(Exception):
    pass


def baseline_view(kb) -> dict:
    p = kb.product
    return {"model": p["model"], "power_w": p["rated_power_w"], "ip_rating": p["protection_rating"],
            "driver": p["driver_model"]}


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _key(*parts) -> str:
    raw = json.dumps(parts, ensure_ascii=False, sort_keys=True, default=str)
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()[:24]


def _evidence_version() -> str:
    try:
        current = workflow2.envelope()
        return str(current.get("evidence_version") or current.get("rule_version") or "unknown")
    except workflow2.Workflow2Error:
        return "unavailable"


def _new_session(session_id: str | None, channel: str, buyer_name: str | None, subject: str | None) -> dict:
    return {
        "session_id": session_id or store.new_id(),
        "channel": channel,
        "buyer_name": buyer_name,
        "subject": subject,
        "languages": ["en", "de"],
        "constraints": {"hide_delivery_date": False},
        "request": None,
        "last_options": [],
        "rounds": [],
        "cache": {},
    }


def merge_request(prev: dict | None, extraction: dict, kb) -> dict:
    base = kb.product
    fields = extraction["fields"]
    tech_change = any(fields[k].get("status") == "changed" for k in extract.TECH_FIELDS)
    req = copy.deepcopy(prev) if prev else {
        "power_w": base["rated_power_w"], "ip_rating": base["protection_rating"],
        "driver": base["driver_model"], "driver_status": "unchanged",
        "quantity": None, "delivery": None, "installation": None,
    }

    if fields["power_w"]["status"] in ("changed", "unchanged"):
        req["power_w"] = fields["power_w"]["value"]

    if fields["ip_rating"]["status"] in ("changed", "unchanged"):
        req["ip_rating"] = fields["ip_rating"]["value"]
    elif not prev and fields["power_w"]["status"] == "changed":
        req["ip_rating"] = None

    status = fields["driver"]["status"]
    if status in ("changed", "unchanged", "tentative"):
        req["driver"] = fields["driver"]["value"] or base["driver_model"]
        req["driver_status"] = status
    elif not prev and tech_change:
        req["driver"] = base["driver_model"]
        req["driver_status"] = "unknown"

    for key in extract.EXTRA_FIELDS:
        if fields[key]["value"] is not None:
            req[key] = fields[key]["value"]
    return req


def _questions(req: dict, mode: str, kb) -> list[str]:
    base = kb.product
    qs = []
    if mode == "confirm_selected":
        return qs
    if req["power_w"] is None:
        qs.append("power_w")
    if req["ip_rating"] is None:
        qs.append("ip_rating")
    if req.get("driver_status") in ("unknown", "tentative"):
        qs.append("driver")
    ip_open = req["ip_rating"] is None or req["ip_rating"] != base["protection_rating"]
    if ip_open and not req.get("installation"):
        qs.append("installation")
    if not req.get("quantity"):
        qs.append("quantity")
    return qs


EMPTY_COVERAGE = {"findings": [], "document_updates": [], "manual_review_required": True, "retest_items": [],
                  "retest_details": {}, "owner_actions": [], "issues": []}


def _owner_actions(primary: dict, mode: str, opts: list[dict]) -> list[dict]:
    acts = []
    if mode == "incomplete":
        acts.append(("SALES", "向买家追问缺失参数，补齐前不报确定价格和交期"))
    if mode == "pending_check":
        acts.append(("QUALITY_COMPLIANCE", "工作流二暂不可用：人工核对证据覆盖与补测后再给买家报价"))
    by_key = {f["item_key"]: f for f in primary["findings"]}
    names = {}
    for o in opts:
        for key in o["retest_items"]:
            names[key] = o["coverage"]["retest_details"].get(key, {}).get("name", {}).get("zh") or key
    if names:
        acts.append(("LAB_PURCHASING", f"向实验室确认 {'、'.join(names[k] for k in sorted(names))} 的排期与报价（当前为合成估算）"))
    for a in primary.get("owner_actions", []):
        if a.get("action"):
            acts.append((a.get("owner_role", "QUALITY_COMPLIANCE"), a["action"]))
    if by_key.get("emc_electrical", {}).get("status") == "MANUAL_REVIEW":
        acts.append(("QUALITY_COMPLIANCE", "确认驱动电源未变时原 EMC 结果能否沿用"))
    if "ingress_protection" in by_key and by_key["ingress_protection"]["status"] == "NEEDS_RETEST":
        acts.append(("ENGINEERING", "确认新防护等级的密封结构、物料与样品安排"))
    if "rohs_evidence" in by_key:
        acts.append(("QUALITY_COMPLIANCE", "收集新增密封件的受限物质证据"))
    if primary["document_updates"]:
        docs = "、".join(primary["document_updates"])
        acts.append(("QUALITY_COMPLIANCE", f"准备更新文件：{docs}"))
    acts.append(("SALES", "审核回复草稿后由本人发送；金额和交期保持待确认措辞"))
    seen, out = set(), []
    for r, a in acts:
        if (r, a) not in seen:
            seen.add((r, a))
            out.append({"owner_role": r, "owner_label": OWNER_LABELS.get(r, r), "action": a, "status": "OPEN"})
    return out


def _change_order(req: dict, extraction: dict, kb) -> list[dict]:
    base = baseline_view(kb)
    fields = extraction["fields"]
    rows = []
    for key, base_key in (("power_w", "power_w"), ("ip_rating", "ip_rating"), ("driver", "driver")):
        value = req.get(key)
        status = fields[key].get("status", "unknown")
        if key == "driver" and req.get("driver_status") in ("tentative", "unknown"):
            status = req["driver_status"]
        elif status == "unknown" and value is not None:
            status = "carried"
        rows.append({
            "field": key, "label": FIELD_LABELS[key],
            "from": base[base_key], "to": value,
            "status": status if value is not None else "missing",
            "source_quote": fields[key].get("source_quote"),
        })
    for key in extract.EXTRA_FIELDS:
        if req.get(key) is not None:
            rows.append({"field": key, "label": FIELD_LABELS[key], "from": None, "to": req[key],
                         "status": "provided" if fields[key]["value"] is not None else "carried",
                         "source_quote": fields[key].get("source_quote")})
    return rows


def _facts_numbers(opts: list[dict], kb) -> dict:
    cov = kb.coverage["power_range_w"]
    priced = [o for o in opts if o.get("unit_price_eur") is not None and o.get("estimated_cost_eur") is not None
              and o.get("lead_time_working_days") is not None and o.get("estimated_days") is not None]
    return {
        "money": [o["unit_price_eur"] for o in priced] + [o["estimated_cost_eur"] for o in priced],
        "days": [o["lead_time_working_days"] for o in priced] + [o["estimated_days"] for o in priced],
        "watts": [o["config"]["power_w"] for o in opts if o["config"].get("power_w") is not None]
                  + [kb.product["rated_power_w"], cov["min"], cov["max"]],
        "retest_required_all": bool(priced) and all(o["retest_items"] for o in priced),
    }


BLOCKING = {"NUMBER_MISMATCH", "CONSTRAINT_VIOLATION", "UNSUPPORTED_CLAIM"}


def _replies(facts: dict, numbers: dict, kb) -> dict:
    out = {}
    for lang in facts["languages"]:
        draft = writer.render_template(lang, facts)
        reply = {**draft, "generator": "template", "fallback_reason": None}
        if llm.configured():
            polished = writer.polish(lang, draft, facts)
            if polished is None:
                reply["fallback_reason"] = "模型不可用或返回格式错误，已使用模板"
            else:
                trial = checker.check(polished["body"], numbers, facts["channel"], facts["constraints"])
                blocked = [a for a in trial["annotations"] if a["category"] in BLOCKING and a["severity"] == "high"]
                if blocked:
                    reply["fallback_reason"] = f"模型润色未通过校验（{blocked[0]['message']}），已回退模板"
                else:
                    reply = {**polished, "generator": "llm", "fallback_reason": None}
        reply["check"] = checker.check(reply["body"], numbers, facts["channel"], facts["constraints"])
        out[lang] = reply
    return out


def _slim_option(o: dict) -> dict:
    keep = ("option_id", "kind", "config", "quantity", "retest_items", "estimated_cost_eur", "estimated_days",
            "days_breakdown", "unit_price_eur", "lead_time_working_days", "assumption", "assumption_version",
            "source_type", "synthetic", "human_confirmed")
    slim = {k: o.get(k) for k in keep}
    slim["fastest"] = o.get("fastest", False)
    slim["findings"] = o["coverage"]["findings"]
    slim["document_updates"] = o["coverage"]["document_updates"]
    return slim


def _build(session: dict, req: dict, extraction: dict, selected: str | None, input_meta: dict, kind: str) -> dict:
    kb = get_kb()
    base = kb.product
    baseline = baseline_view(kb)
    quantity = req.get("quantity") or kb.commercial["pricing"]["default_quantity"]
    wf2_meta = {"contract_version": workflow2.CONTRACT_VERSION, "provider": workflow2.provider_name(),
                "ok": True, "error": None, "warnings": [], "rule_version": None, "evidence_version": None}
    selected_option, opts, primary = None, [], None
    missing_core = req["power_w"] is None or req["ip_rating"] is None

    try:
        env = workflow2.envelope()
        prior = next((o for o in session["last_options"] if o["option_id"] == selected), None) if selected else None
        if prior:
            selected_config = {k: prior["config"][k] for k in ("power_w", "ip_rating", "driver")}
            for key in extract.TECH_FIELDS:
                field = extraction["fields"].get(key, {})
                if field.get("status") in ("changed", "unchanged", "tentative") and field.get("value") is not None:
                    selected_config[key] = req[key]
            req = {**req, **selected_config}
            req["driver_status"] = "changed" if selected_config["driver"] != base["driver_model"] else "unchanged"
            ev = workflow2.evaluate({selected: selected_config})
            selected_option = options.build_option(selected, prior["kind"], ev["results"][selected], quantity, baseline, kb)
            mode, opts = "confirm_selected", [selected_option]
        elif missing_core:
            partial = {"power_w": req["power_w"], "ip_rating": req["ip_rating"],
                       "driver": req["driver"] if req.get("driver_status") != "unknown" else None}
            ev = workflow2.evaluate({"A": partial})
            mode, primary = "incomplete", ev["results"]["A"]
        else:
            plans = options.plan(req, env)
            ev = workflow2.evaluate({oid: cfg for oid, (_, cfg) in plans.items()})
            opts = options.mark_fastest([options.build_option(oid, option_kind, ev["results"][oid], quantity, baseline, kb)
                                         for oid, (option_kind, _) in plans.items()])
            unchanged = (req["power_w"] == base["rated_power_w"] and req["ip_rating"] == base["protection_rating"]
                         and req["driver"] == base["driver_model"] and req.get("driver_status") == "unchanged")
            mode = "no_change" if unchanged else "options"
        wf2_meta.update(rule_version=ev["rule_version"],
                        evidence_version=ev.get("evidence_version") or env.get("evidence_version") or ev["rule_version"],
                        warnings=ev["warnings"])
    except workflow2.Workflow2Error as exc:
        wf2_meta.update(ok=False, error=str(exc))
        mode = "incomplete" if missing_core else "pending_check"
        selected_option, opts = None, []

    all_options = opts
    priced_options = [o for o in opts if o.get("estimated_cost_eur") is not None and o.get("estimated_days") is not None
                     and o.get("unit_price_eur") is not None
                     and not o.get("coverage", {}).get("manual_review_required")]
    opts = priced_options
    if all_options and not opts:
        mode = "pending_check"
    elif all_options and (all_options[0].get("estimated_cost_eur") is None
                        or all_options[0].get("estimated_days") is None
                        or all_options[0].get("unit_price_eur") is None):
        mode = "pending_check"
    primary = primary or (all_options[0]["coverage"] if all_options else EMPTY_COVERAGE)
    questions = _questions(req, mode, kb)
    numbers = _facts_numbers(opts, kb)
    facts = {
        "languages": session["languages"],
        "channel": session["channel"],
        "buyer_name": session.get("buyer_name"),
        "subject": session.get("subject"),
        "baseline": baseline_view(kb),
        "mode": mode,
        "options": opts,
        "selected_option": selected_option,
        "questions": questions,
        "constraints": session["constraints"],
        "signature": mail_settings()["signature"],
    }
    replies = _replies(facts, numbers, kb)

    if mode == "incomplete":
        status = "INPUT_INCOMPLETE"
    elif mode == "pending_check" or primary["manual_review_required"] or any(o["retest_items"] for o in opts):
        status = "NEEDS_MANUAL_REVIEW"
    else:
        status = "READY_FOR_REVIEW"

    result = {
        "run_id": "RUN-" + uuid.uuid4().hex[:10],
        "session_id": session["session_id"],
        "round": len(session["rounds"]) + 1,
        "kind": kind,
        "created_at": _now(),
        "scope": {"market": kb.manifest["scope"]["market"], "product_scope": kb.manifest["scope"]["product_scope"],
                  "rule_version": wf2_meta["rule_version"], "evidence_version": wf2_meta["evidence_version"],
                  "pricing_version": kb.commercial["assumption_version"]},
        "workflow2": wf2_meta,
        "status": status,
        "mode": mode,
        "input": input_meta,
        "channel": session["channel"],
        "languages": session["languages"],
        "constraints": dict(session["constraints"]),
        "extraction": {"method": extraction["method"], "warnings": extraction["warnings"],
                       "language": extraction["language"]},
        "change_order": _change_order(req, extraction, kb),
        "questions": [{"key": q, "zh": writer.QUESTIONS[q]["zh"]} for q in questions],
        "coverage_findings": primary["findings"],
        "document_updates": primary["document_updates"],
        "consistency_issues": primary.get("issues", []),
        "quote_options": [_slim_option(o) for o in opts],
        "selected_option_id": selected_option["option_id"] if selected_option else None,
        "owner_actions": _owner_actions(primary, mode, all_options),
        "replies": replies,
        "assumptions": [
            f"证据覆盖与补测代价来自工作流二（{wf2_meta['provider']}，规则 {wf2_meta['rule_version'] or '不可用'}）",
            "补测费用、周期和单价为合成估算，待采购/实验室和工程确认",
            "未提供订单数量时按 " + str(kb.commercial["pricing"]["default_quantity"]) + " 件估算" if not req.get("quantity") else "订单数量来自买家消息",
        ],
        "llm": llm.model_name(),
        "idempotent_replay": False,
    }

    session["request"] = req
    session["extraction"] = extraction
    if opts and mode != "confirm_selected":
        session["last_options"] = [{"option_id": o["option_id"], "kind": o["kind"], "config": o["config"]} for o in opts]
    session["rounds"].append({"round": result["round"], "kind": kind, "run_id": result["run_id"],
                              "input": input_meta, "created_at": result["created_at"]})
    session["last_result"] = result
    return result


def analyze_message(text: str, session_id: str | None = None, channel: str = "email",
                    buyer_name: str | None = None, subject: str | None = None,
                    languages: list[str] | None = None, source: str = "manual") -> dict:
    text = (text or "").strip()
    if not text:
        raise PipelineError("买家消息为空")
    if channel not in CHANNELS:
        raise PipelineError(f"不支持的渠道：{channel}")
    kb = get_kb()
    session = store.load(session_id) or _new_session(session_id, channel, buyer_name, subject)
    session["channel"] = channel
    session["buyer_name"] = buyer_name or session.get("buyer_name")
    session["subject"] = subject or session.get("subject")
    if languages:
        session["languages"] = [x for x in languages if x in ("en", "de")] or session["languages"]

    key = _key("message", session["session_id"], text, channel, session["languages"],
               session["constraints"], kb.rule_version, _evidence_version(), workflow2.provider_name(), llm.model_name())
    if key in session["cache"]:
        cached = session["cache"][key]
        return {**cached, "idempotent_replay": True}

    extraction = extract.extract(text, kb.product)
    req = merge_request(session.get("request"), extraction, kb)
    input_meta = {"text": text, "source": source, "language": extraction["language"]}
    result = _build(session, req, extraction, extraction["selected_option"], input_meta, "buyer_message")
    _remember(session, key, result)
    return result


def _remember(session: dict, key: str, result: dict) -> None:
    result["idempotency_key"] = key
    if result["workflow2"]["ok"]:
        session["cache"][key] = result
    else:
        session["uncached"] = (session.get("uncached", []) + [result])[-5:]
    store.save(session)


def apply_instruction(session_id: str, instruction: str) -> dict:
    instruction = (instruction or "").strip()
    session = store.load(session_id)
    if not session or not session.get("last_result"):
        raise PipelineError("会话不存在，请先分析一条买家消息")
    if not instruction:
        raise PipelineError("指令为空")
    kb = get_kb()
    key = _key("instruction", session_id, instruction, session["last_result"]["run_id"], kb.rule_version,
               _evidence_version(), workflow2.provider_name(), llm.model_name())
    if key in session["cache"]:
        return {**session["cache"][key], "idempotent_replay": True}

    technical = extract.extract(instruction, kb.product)
    parsed = extract.parse_instruction(instruction)
    has_technical = any(technical["fields"][k].get("value") is not None for k in extract.TECH_FIELDS + extract.EXTRA_FIELDS)
    if all(v is None for v in parsed.values()) and not has_technical:
        raise PipelineError("没有识别出可执行的修改。可以尝试：选方案A / 先不要承诺交期 / 只要德语 / 改成邮件风格")
    if parsed["hide_delivery_date"] is not None:
        session["constraints"]["hide_delivery_date"] = parsed["hide_delivery_date"]
    if parsed["languages"]:
        session["languages"] = parsed["languages"]
    if parsed["channel"]:
        session["channel"] = parsed["channel"]

    last = session["last_result"]
    selected = parsed["select_option"] or last.get("selected_option_id")
    if parsed["select_option"] and not any(o["option_id"] == parsed["select_option"] for o in session["last_options"]):
        raise PipelineError(f"上一轮没有方案 {parsed['select_option']}")
    merged = merge_request(session.get("request"), technical, kb) if has_technical else session["request"]
    input_meta = {"text": instruction, "source": "sales_instruction", "parsed": parsed}
    result = _build(session, merged, technical if has_technical else session["extraction"], selected, input_meta, "instruction")
    _remember(session, key, result)
    return result


def check_reply(text: str, session_id: str | None = None, channel: str | None = None) -> dict:
    session = store.load(session_id)
    numbers, constraints = {}, {}
    if session and session.get("last_result"):
        last = session["last_result"]
        kb = get_kb()
        opts = [{"unit_price_eur": o["unit_price_eur"], "estimated_cost_eur": o["estimated_cost_eur"],
                 "lead_time_working_days": o["lead_time_working_days"], "estimated_days": o["estimated_days"],
                 "config": o["config"], "retest_items": o["retest_items"]} for o in last["quote_options"]]
        numbers = _facts_numbers(opts, kb) if opts else {}
        constraints = session["constraints"]
        channel = channel or session["channel"]
    return checker.check(text or "", numbers, channel or "email", constraints)


def get_session(session_id: str) -> dict | None:
    session = store.load(session_id)
    if not session:
        return None
    history = list(session["cache"].values()) + session.get("uncached", [])
    history.sort(key=lambda r: r["created_at"])
    return {k: v for k, v in session.items() if k not in ("cache", "uncached")} | {"history": history}

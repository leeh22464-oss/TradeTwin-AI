"""工作流二的本地参考实现：证据覆盖推理、最小补测与补测代价（确定性规则，不调用模型）。
队友的正式实现接入后，这里只作为契约样例和离线兜底；对外接口见 workflow2.py。"""

from .knowledge import KnowledgeBase

CONTRACT_VERSION = "tradetwin.wf2.v1"

REPORT_DOC = "DOC-CONFLICT-TEST-001"
DOC_DOC = "DOC-CONFLICT-DOC-001"
LABEL_DOC = "DOC-CONFLICT-LABEL-001"


def _ev(kb: KnowledgeBase, document_id: str, needle: str) -> list[dict]:
    found = kb.evidence(document_id, needle)
    return [found] if found else []


def evaluate(config: dict, kb: KnowledgeBase) -> dict:
    """config: {power_w, ip_rating, driver}；值为 None 表示未确认。"""
    cov = kb.coverage
    base = kb.product
    lo, hi = cov["power_range_w"]["min"], cov["power_range_w"]["max"]
    power, ip, driver = config.get("power_w"), config.get("ip_rating"), config.get("driver")
    findings: list[dict] = []

    if power is None:
        findings.append(_finding("thermal_rise", "温升与耐热相关测试", "NOT_ENOUGH_EVIDENCE",
                                 "目标功率未确认，无法与报告覆盖区间比较",
                                 _ev(kb, REPORT_DOC, "覆盖功率区间"), ["RULE-FIELD-COMPLETE-001"]))
    elif lo <= power <= hi:
        findings.append(_finding("thermal_rise", "温升与耐热相关测试", "COVERED",
                                 f"{power}W 位于报告覆盖区间 {lo}–{hi}W 内",
                                 _ev(kb, REPORT_DOC, "覆盖功率区间"), ["RULE-COVERAGE-RANGE-001"]))
    else:
        findings.append(_finding("thermal_rise", "温升与耐热相关测试", "NEEDS_RETEST",
                                 f"{power}W 超出报告覆盖区间 {lo}–{hi}W",
                                 _ev(kb, REPORT_DOC, "覆盖功率区间"),
                                 ["RULE-COVERAGE-RANGE-001", "RULE-RETEST-MINIMUM-001"]))

    if ip is None:
        findings.append(_finding("ingress_protection", "防尘防水（IP）测试", "NOT_ENOUGH_EVIDENCE",
                                 "目标防护等级未确认", _ev(kb, REPORT_DOC, "覆盖防护等级"),
                                 ["RULE-FIELD-COMPLETE-001"]))
    elif ip == cov["protection_rating"]:
        findings.append(_finding("ingress_protection", "防尘防水（IP）测试", "COVERED",
                                 f"防护等级与报告一致（{ip}）", _ev(kb, REPORT_DOC, "覆盖防护等级"),
                                 ["RULE-COVERAGE-RANGE-001"]))
    else:
        findings.append(_finding("ingress_protection", "防尘防水（IP）测试", "NEEDS_RETEST",
                                 f"{ip} 不同于报告覆盖的 {cov['protection_rating']}",
                                 _ev(kb, REPORT_DOC, "覆盖防护等级"),
                                 ["RULE-PARAMETER-TEST-MAP-001", "RULE-RETEST-MINIMUM-001"]))

    if driver is None:
        findings.append(_finding("emc_electrical", "EMC 与电气安全复核", "NOT_ENOUGH_EVIDENCE",
                                 "驱动电源是否沿用未确认", _ev(kb, REPORT_DOC, "覆盖驱动电源"),
                                 ["RULE-FIELD-COMPLETE-001"]))
    elif driver == cov["driver_model"]:
        findings.append(_finding("emc_electrical", "EMC 与电气安全复核", "MANUAL_REVIEW",
                                 f"驱动电源 {driver} 未变，可能沿用原 EMC 结果，须工程/品质确认",
                                 _ev(kb, REPORT_DOC, "覆盖提示"), ["RULE-DRIVER-REUSE-001"]))
    else:
        findings.append(_finding("emc_electrical", "EMC 与电气安全复核", "NEEDS_RETEST",
                                 f"更换驱动电源（{driver}），原 EMC 与电气结果不再适用",
                                 _ev(kb, REPORT_DOC, "覆盖驱动电源"),
                                 ["RULE-PARAMETER-TEST-MAP-001", "RULE-RETEST-MINIMUM-001"]))

    if ip is not None and ip != cov["protection_rating"]:
        findings.append(_finding("rohs_evidence", "受限物质证据", "MANUAL_REVIEW",
                                 "防护结构变化可能引入新密封件，需补充对应材料证据",
                                 _ev(kb, REPORT_DOC, "覆盖测试项目"), ["RULE-ROHS-EVIDENCE-001"]))

    updates: list[str] = []
    changed = {
        "power": power is not None and power != base["rated_power_w"],
        "ip": ip is not None and ip != base["protection_rating"],
        "driver": driver is not None and driver != base["driver_model"],
    }
    if any(changed.values()):
        updates += ["DoC", "label"]
        evidence = _ev(kb, DOC_DOC, "声明对象型号")
        if changed["ip"]:
            updates.append("German instructions")
            evidence += _ev(kb, LABEL_DOC, "德语版本")
        findings.append(_finding("document_update", "DoC / 标签 / 说明书更新", "DOCUMENT_UPDATE",
                                 "型号、额定值或防护等级变化，需与最终配置同步：" + "、".join(updates),
                                 evidence, ["RULE-DOCUMENT-UPDATE-001"]))

    retests = [f["item_key"] for f in findings if f["status"] == "NEEDS_RETEST"]
    incomplete = [f["item_key"] for f in findings if f["status"] == "NOT_ENOUGH_EVIDENCE"]
    return {
        "config": dict(config),
        "findings": findings,
        "retest_items": retests,
        "document_updates": updates,
        "incomplete": incomplete,
        "manual_review_required": any(f["status"] in ("MANUAL_REVIEW", "NOT_ENOUGH_EVIDENCE") for f in findings),
        "driver_changed": changed["driver"],
    }


def _cost(result: dict, kb: KnowledgeBase) -> dict:
    table = kb.commercial
    items = [key for key in result["retest_items"] if key in table["test_items"]]
    lab_days = max((table["test_items"][key]["lab_days"] for key in items), default=0)
    sample_days = table["new_driver_sample_days"] if result["driver_changed"] else 0
    doc_days = table["document_update_days"] if result["document_updates"] else 0
    return {
        "retest_items": [{
            "test_key": key,
            "name": {lang: table["test_items"][key][lang] for lang in ("zh", "en", "de")},
            "cost_eur": table["test_items"][key]["cost_eur"],
            "lab_days": table["test_items"][key]["lab_days"],
        } for key in items],
        "estimated_cost_eur": sum(table["test_items"][key]["cost_eur"] for key in items),
        "estimated_days": sample_days + lab_days + doc_days,
        "days_breakdown": {"new_driver_sample": sample_days, "lab_parallel": lab_days, "document_update": doc_days},
    }


def contract_envelope(kb: KnowledgeBase) -> dict:
    cov, base = kb.coverage, kb.product
    return {
        "contract_version": CONTRACT_VERSION,
        "rule_version": kb.rule_version,
        "product": {"model": base["model"], "power_w": base["rated_power_w"], "ip_rating": base["protection_rating"],
                    "driver": base["driver_model"]},
        "coverage": {
            "report_id": cov.get("report_id"),
            "power_range_w": {"min": cov["power_range_w"]["min"], "max": cov["power_range_w"]["max"]},
            "ip_rating": cov["protection_rating"],
            "driver": cov["driver_model"],
            "evidence": _ev(kb, REPORT_DOC, "覆盖功率区间"),
        },
    }


def contract_evaluate(request: dict, kb: KnowledgeBase) -> dict:
    results = []
    for cfg in request.get("configs", []):
        config = {k: cfg.get(k) for k in ("power_w", "ip_rating", "driver")}
        result = evaluate(config, kb)
        results.append({
            "config_id": cfg.get("config_id"),
            "findings": result["findings"],
            "document_updates": result["document_updates"],
            "manual_review_required": result["manual_review_required"],
            **_cost(result, kb),
            "synthetic": True,
            "human_confirmed": False,
            "source_type": "synthetic_demo_mapping",
            "assumption_version": kb.commercial["assumption_version"],
        })
    return {"contract_version": CONTRACT_VERSION, "rule_version": kb.rule_version,
            "request_id": request.get("request_id"), "results": results}


def _finding(key, item, status, reason, evidence, rule_refs) -> dict:
    return {
        "item_key": key,
        "item": item,
        "status": status,
        "reason": reason,
        "evidence": evidence,
        "rule_refs": rule_refs,
    }

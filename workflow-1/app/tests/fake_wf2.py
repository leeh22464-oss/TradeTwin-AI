"""Synthetic Workflow 2 provider. Verified reports exist only in this test fixture."""

from tradetwin import coverage
from tradetwin.knowledge import get_kb

BEHAVIOUR = {"mode": "ok", "evidence_version": "evidence-v1", "verified_evidence": False}


def envelope():
    data = coverage.contract_envelope(get_kb())
    data["evidence_version"] = BEHAVIOUR["evidence_version"]
    if BEHAVIOUR["mode"] == "missing_evidence_version":
        data.pop("evidence_version", None)
    if BEHAVIOUR["mode"] == "missing_envelope_rule_version":
        data["rule_version"] = " "
    return data


def evaluate(request):
    data = coverage.contract_evaluate(request, get_kb())
    data["evidence_version"] = BEHAVIOUR["evidence_version"]
    mode = BEHAVIOUR["mode"]
    if mode == "missing_evaluation_rule_version":
        data.pop("rule_version", None)
    for result in data["results"]:
        if BEHAVIOUR["verified_evidence"]:
            for finding in result["findings"]:
                key = finding["item_key"]
                if finding["status"] == "MANUAL_REVIEW" and key in ("emc_electrical", "rohs_evidence"):
                    finding.update(status="COVERED", reason="Independently verified synthetic fixture report",
                                   evidence=[{"document_id": "FIXTURE-VERIFIED-" + key, "page": 1,
                                              "quote": "Synthetic verified evidence covers this exact power, driver, structure and material configuration."}])
            result["manual_review_required"] = any(f["status"] in ("MANUAL_REVIEW", "NOT_ENOUGH_EVIDENCE")
                                                    for f in result["findings"])
            if not result["manual_review_required"]:
                result["estimated_cost_eur"] = sum(item["cost_eur"] for item in result["retest_items"])
                result["estimated_days"] = sum(result["days_breakdown"].values())
        if mode == "covered_without_evidence":
            for f in result["findings"]:
                if f["status"] == "COVERED":
                    f["evidence"] = []
        elif mode == "missing_cost":
            result.pop("estimated_cost_eur")
        elif mode == "extra_fields":
            result["owner_actions"] = [{"owner_role": "ENGINEERING", "action": "队友待办：确认散热片尺寸"}]
            result["issues"] = [{"finding": "规格书型号与 DoC 不一致", "evidence": []}]
        elif mode == "missing_evidence_version":
            data.pop("evidence_version", None)
        elif mode == "missing_evaluation_evidence_version":
            data.pop("evidence_version", None)
        elif mode == "unknown_status":
            result["findings"][0]["status"] = "UNRECOGNIZED"
        elif mode == "manual_review_priced":
            result["manual_review_required"] = True
            for finding in result["findings"]:
                finding["status"] = "MANUAL_REVIEW"
    return data

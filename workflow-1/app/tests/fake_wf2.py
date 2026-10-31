"""模拟队友的工作流二模块：复用参考实现，再按 BEHAVIOUR 注入不同的偏差。"""

from tradetwin import coverage
from tradetwin.knowledge import get_kb

BEHAVIOUR = {"mode": "ok", "evidence_version": "evidence-v1"}


def envelope():
    data = coverage.contract_envelope(get_kb())
    data["evidence_version"] = BEHAVIOUR["evidence_version"]
    if BEHAVIOUR["mode"] == "missing_evidence_version":
        data.pop("evidence_version", None)
    return data


def evaluate(request):
    data = coverage.contract_evaluate(request, get_kb())
    data["evidence_version"] = BEHAVIOUR["evidence_version"]
    mode = BEHAVIOUR["mode"]
    for result in data["results"]:
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
        elif mode == "manual_review_priced":
            result["manual_review_required"] = True
            for finding in result["findings"]:
                finding["status"] = "MANUAL_REVIEW"
    return data

"""Regression coverage for the workflow-1/workflow-2 integration boundary."""

import fake_wf2
from tradetwin import pipeline
from test_engine import DE_RFQ


def test_request_id_mismatch_fails_without_quote(teammate, monkeypatch):
    teammate["mode"] = "ok"

    def mismatched(request):
        data = fake_wf2.coverage.contract_evaluate(request, fake_wf2.get_kb())
        data["request_id"] = "WF1-wrong"
        return data

    monkeypatch.setattr("fake_wf2.evaluate", mismatched)
    result = pipeline.analyze_message(DE_RFQ, session_id="integration-request-id")
    assert result["mode"] == "pending_check"
    assert result["quote_options"] == []
    assert not result["workflow2"]["ok"]


def test_null_estimates_are_excluded_but_findings_remain(teammate, monkeypatch):
    original_evaluate = fake_wf2.evaluate

    def null_cost(request):
        data = original_evaluate(request)
        for result in data["results"]:
            result["estimated_cost_eur"] = None
            result["estimated_days"] = None
        return data

    monkeypatch.setattr("fake_wf2.evaluate", null_cost)
    result = pipeline.analyze_message(DE_RFQ, session_id="integration-null-cost")
    assert result["mode"] == "pending_check"
    assert result["quote_options"] == []
    assert result["coverage_findings"]


def test_selected_option_applies_explicit_technical_changes(teammate):
    pipeline.analyze_message(DE_RFQ, session_id="integration-explicit-selection")
    result = pipeline.apply_instruction(
        "integration-explicit-selection", "选方案C，改成 28 Watt、IP44 和 DRV-B"
    )
    assert result["selected_option_id"] == "C"
    assert result["quote_options"][0]["config"] == {
        "power_w": 28,
        "ip_rating": "IP44",
        "driver": "DRV-B",
    }


def test_evidence_version_is_part_of_result_and_replay_key(teammate):
    result = pipeline.analyze_message(DE_RFQ, session_id="integration-evidence-version")
    assert result["scope"]["evidence_version"]
    replay = pipeline.analyze_message(DE_RFQ, session_id="integration-evidence-version")
    assert replay["idempotent_replay"]


def test_evidence_change_forces_a_new_workflow2_run(teammate):
    teammate["evidence_version"] = "evidence-v1"
    first = pipeline.analyze_message(DE_RFQ, session_id="evidence-refresh")
    replay = pipeline.analyze_message(DE_RFQ, session_id="evidence-refresh")
    assert replay["idempotent_replay"] is True

    teammate["evidence_version"] = "evidence-v2"
    refreshed = pipeline.analyze_message(DE_RFQ, session_id="evidence-refresh")
    assert refreshed["idempotent_replay"] is False
    assert refreshed["run_id"] != first["run_id"]
    assert refreshed["scope"]["evidence_version"] == "evidence-v2"


def test_hide_delivery_removes_delivery_line(teammate):
    pipeline.analyze_message(DE_RFQ, session_id="integration-hide-delivery")
    result = pipeline.apply_instruction("integration-hide-delivery", "选方案C，先不要承诺交期")
    for reply in result["replies"].values():
        assert "working days" not in reply["body"]
        assert "Arbeitstage" not in reply["body"]

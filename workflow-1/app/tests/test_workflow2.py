import pytest

import fake_wf2
from tradetwin import pipeline, workflow2
from test_engine import DE_RFQ

def test_teammate_module_gives_same_options(teammate):
    result = pipeline.analyze_message(DE_RFQ, session_id="wf2-ok")
    assert result["workflow2"]["provider"] == "python:fake_wf2" and result["workflow2"]["ok"]
    costs = {o["option_id"]: (o["estimated_cost_eur"], o["estimated_days"]) for o in result["quote_options"]}
    assert costs == {"A": (2100, 8), "B": (3600, 12), "C": (900, 7)}


def test_covered_without_evidence_is_downgraded(teammate):
    teammate["mode"] = "covered_without_evidence"
    result = pipeline.analyze_message(DE_RFQ, session_id="wf2-noev")
    option_c = next(o for o in result["quote_options"] if o["option_id"] == "C")
    thermal = next(f for f in option_c["findings"] if f["item_key"] == "thermal_rise")
    assert thermal["status"] == "MANUAL_REVIEW"
    assert any("降为 MANUAL_REVIEW" in w for w in result["workflow2"]["warnings"])


def test_teammate_actions_and_issues_are_internal_only(teammate):
    teammate["mode"] = "extra_fields"
    result = pipeline.analyze_message(DE_RFQ, session_id="wf2-extra")
    assert any("散热片" in a["action"] for a in result["owner_actions"])
    assert result["consistency_issues"]
    for reply in result["replies"].values():
        assert "DoC 不一致" not in reply["body"]


@pytest.mark.parametrize("setup", ["missing_cost", "service_down"])
def test_workflow2_failure_never_quotes(teammate, monkeypatch, setup):
    if setup == "missing_cost":
        teammate["mode"] = "missing_cost"
    else:
        monkeypatch.setenv("WORKFLOW2_MODE", "http")
        monkeypatch.setenv("WORKFLOW2_URL", "http://127.0.0.1:9")
        monkeypatch.setenv("WORKFLOW2_TIMEOUT", "1")
    session = "wf2-fail-" + setup
    result = pipeline.analyze_message(DE_RFQ, session_id=session)
    assert not result["workflow2"]["ok"]
    assert result["mode"] == "pending_check" and result["quote_options"] == []
    for reply in result["replies"].values():
        assert "EUR" not in reply["body"] and "Arbeitstage" not in reply["body"]

    teammate["mode"] = "ok"
    monkeypatch.setenv("WORKFLOW2_MODE", "python")
    workflow2._cache.clear()
    recovered = pipeline.analyze_message(DE_RFQ, session_id=session)
    assert not recovered["idempotent_replay"] and recovered["quote_options"]


def test_missing_evidence_version_fails_closed(teammate):
    teammate["mode"] = "missing_evidence_version"
    result = pipeline.analyze_message(DE_RFQ, session_id="wf2-no-evidence-version")
    assert result["mode"] == "pending_check"
    assert result["quote_options"] == []
    assert not result["workflow2"]["ok"]


def test_manual_review_with_numeric_estimates_never_quotes(teammate):
    teammate["mode"] = "manual_review_priced"
    result = pipeline.analyze_message(DE_RFQ, session_id="wf2-manual-priced")
    assert result["coverage_findings"]
    assert result["quote_options"] == []
    assert result["mode"] == "pending_check"


def test_workflow2_defaults_to_integrated_http(monkeypatch):
    monkeypatch.delenv("WORKFLOW2_MODE", raising=False)
    monkeypatch.delenv("WORKFLOW2_URL", raising=False)
    settings = workflow2.settings()
    assert settings["mode"] == "http"
    assert settings["url"] == "http://127.0.0.1:3001/api/workflow2"

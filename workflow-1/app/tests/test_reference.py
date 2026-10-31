"""The offline reference has unresolved evidence and must never masquerade as verified quotes."""

import copy
import shutil

import pytest

from tradetwin import coverage, knowledge, pipeline
from tradetwin.knowledge import get_kb
from test_engine import DE_RFQ


@pytest.mark.parametrize("change", ["evidence", "fees", "coverage", "rules"])
def test_reference_evidence_version_hashes_inputs(change):
    kb = copy.deepcopy(get_kb())
    before = coverage.contract_envelope(kb)["evidence_version"]
    assert before and before != kb.rule_version
    assert coverage.contract_envelope(copy.deepcopy(kb))["evidence_version"] == before
    if change == "evidence":
        kb.documents[coverage.REPORT_DOC].pages[2] += "\nRevised evidence-only scope note."
    elif change == "fees":
        kb.commercial["test_items"]["ingress_protection"]["cost_eur"] += 10
    elif change == "coverage":
        kb.coverage["power_range_w"]["max"] = 29
    else:
        kb.rules["RULE-DRIVER-REUSE-001"]["title"] += " revised"
    after = coverage.contract_envelope(kb)["evidence_version"]
    assert before != after
    response = coverage.contract_evaluate({"configs": [{"config_id": "A", "power_w": 36,
                                                       "ip_rating": "IP44", "driver": "DRV-A"}]}, kb)
    assert response["evidence_version"] == after
    result = response["results"][0]
    assert result["manual_review_required"]
    assert result["estimated_cost_eur"] is None and result["estimated_days"] is None


def test_reference_evidence_only_change_invalidates_replay(monkeypatch):
    kb = copy.deepcopy(get_kb())
    monkeypatch.setattr("tradetwin.workflow2.get_kb", lambda: kb)
    sid = "local-reference-evidence-refresh"
    first = pipeline.analyze_message(DE_RFQ, session_id=sid)
    assert pipeline.analyze_message(DE_RFQ, session_id=sid)["idempotent_replay"]
    kb.documents[coverage.REPORT_DOC].pages[2] += "\nUpdated evidence; unchanged rule version."
    refreshed = pipeline.analyze_message(DE_RFQ, session_id=sid)
    assert not refreshed["idempotent_replay"]
    assert refreshed["scope"]["evidence_version"] != first["scope"]["evidence_version"]
    assert refreshed["scope"]["rule_version"] == first["scope"]["rule_version"]
    assert refreshed["mode"] == "pending_check" and refreshed["quote_options"] == []


def test_local_reference_reads_evidence_edits_from_disk(tmp_path, monkeypatch):
    copied = tmp_path / "knowledge-base"
    shutil.copytree(get_kb().kb_dir, copied)
    monkeypatch.setattr(knowledge, "KB_DIR", copied)
    first = pipeline.analyze_message(DE_RFQ, session_id="local-disk-evidence")
    # Use the document metadata to find the copied report rather than a filename convention.
    report = next(doc.path for doc in knowledge.KnowledgeBase(copied).documents.values()
                  if doc.document_id == coverage.REPORT_DOC)
    report.write_text(report.read_text(encoding="utf-8") + "\nEvidence-only revision.\n", encoding="utf-8")
    refreshed = pipeline.analyze_message(DE_RFQ, session_id="local-disk-evidence")
    assert not refreshed["idempotent_replay"]
    assert first["scope"]["evidence_version"] != refreshed["scope"]["evidence_version"]

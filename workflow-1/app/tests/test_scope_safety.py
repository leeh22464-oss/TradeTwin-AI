"""Buyer scope and pending-delivery safety through real extraction, persistence and draft checks."""

import pytest
from fastapi.testclient import TestClient
from unittest.mock import Mock

from tradetwin import checker, config, extract, mailbox, pipeline, store, writer
from tradetwin.server import app
from test_engine import DE_RFQ


@pytest.fixture(autouse=True)
def isolated_runtime(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "RUNTIME_DIR", tmp_path)
    monkeypatch.setattr(mailbox, "RUNTIME_DIR", tmp_path)
    monkeypatch.setattr(store, "RUNTIME_DIR", tmp_path)
    mailbox.invalidate()
    yield
    mailbox.invalidate()


DELIVERY_PROMISES = [
    "Estimated delivery in 2 weeks.", "Estimated delivery in 2 months.",
    "Estimated delivery in two weeks.", "Estimated delivery on 2026-12-01.",
    "Estimated delivery on December 1, 2026.", "Estimated delivery in CW 49.",
    "Estimated delivery on December 1.",
    "Geschätzte Lieferung in 2 Wochen.", "Geschätzte Lieferung in 2 Monaten.",
    "Geschätzte Lieferung in zwei Wochen.", "Geschätzte Lieferung am 01.12.2026.",
    "Geschätzte Lieferung am 1. Dezember 2026.", "Geschätzte Lieferung in KW 49.",
    "Geschätzte Lieferung am 1. Dezember.",
    "预估2周交货。", "预估2个月交货。", "预估两周交货。", "预估2026年12月1日交货。",
    "预估第49周交货。",
    "预估12月1日交货。",
]


@pytest.mark.parametrize("body", DELIVERY_PROMISES)
def test_pending_delivery_promises_are_blocked_in_checker_and_draft(body):
    client = TestClient(app)
    thread = client.get("/api/mail/threads?refresh=true").json()["threads"][0]
    sid = thread["thread_id"]
    pending = pipeline.analyze_message(DE_RFQ, session_id=sid)
    assert pending["mode"] == "pending_check" and not pending["quote_options"]
    checked = pipeline.check_reply(body, sid)
    assert checked["level"] == "red", checked
    draft = client.post("/api/mail/draft", json={"thread_id": sid, "body": body, "subject": "Delivery update"})
    assert draft.status_code == 409, draft.text
    assert checker.check(body)["level"] != "red"  # No session facts: generic editing remains available.


def test_pending_polish_cannot_introduce_week_estimate(monkeypatch):
    monkeypatch.setattr("tradetwin.llm.configured", lambda: True)
    monkeypatch.setattr(writer, "polish", lambda *args: {"subject": "Delivery", "body": "Estimated delivery in 2 weeks."})
    result = pipeline.analyze_message(DE_RFQ, session_id="pending-polish-weeks")
    assert all(reply["generator"] == "template" and reply["fallback_reason"] for reply in result["replies"].values())


SCOPE_CHANGES = [
    ("replace the original material with PVC", "material", "PVC"),
    ("for the United States market", "market", "US"),
    ("将材质更换为PVC", "material", "PVC"),
    ("目标市场改为美国", "market", "US"),
    ("Material auf PVC ändern", "material", "PVC"),
    ("für den Markt Vereinigte Staaten", "market", "US"),
]


def assert_scope_pending(result, field, value, quote):
    assert result["mode"] == "pending_check" and not result["quote_options"]
    row = next(row for row in result["change_order"] if row["field"] == field)
    assert row["to"] == value and row["source_quote"] and row["source_quote"] in quote
    issue = next(issue for issue in result["consistency_issues"] if issue.get("field") == field)
    assert issue["source_quote"] == row["source_quote"]
    assert any(value in action["action"] for action in result["owner_actions"])
    assert all("EUR" not in reply["body"] and "working days" not in reply["body"]
               and "Arbeitstage" not in reply["body"] for reply in result["replies"].values())


@pytest.mark.parametrize("change,field,value", SCOPE_CHANGES)
def test_direct_unsupported_scope_never_evaluates_baseline(verified_workflow2, monkeypatch, change, field, value):
    calls = []
    monkeypatch.setattr("tradetwin.workflow2.evaluate", lambda configs: calls.append(configs))
    text = DE_RFQ + " " + change
    result = pipeline.analyze_message(text, session_id="direct-scope-" + change)
    assert_scope_pending(result, field, value, text)
    assert calls == []
    assert "scope" in result["replies"]["en"]["body"].lower()


@pytest.mark.parametrize("change,field,value", SCOPE_CHANGES[:2])
@pytest.mark.parametrize("through_instruction", [False, True])
def test_later_scope_survives_selection_style_and_repeated_rfq(verified_workflow2, change, field, value, through_instruction):
    sid = "later-scope-" + field + str(through_instruction)
    assert pipeline.analyze_message(DE_RFQ, session_id=sid)["quote_options"]
    changed = (pipeline.apply_instruction(sid, change) if through_instruction
               else pipeline.analyze_message(change, session_id=sid))
    assert_scope_pending(changed, field, value, change)
    selected = pipeline.apply_instruction(sid, "选方案C")
    assert selected["selected_option_id"] == "C"
    assert_scope_pending(selected, field, value, change)
    styled = pipeline.apply_instruction(sid, "只要德语")
    assert styled["selected_option_id"] == "C"
    assert_scope_pending(styled, field, value, change)
    repeated = pipeline.analyze_message(DE_RFQ, session_id=sid)
    assert_scope_pending(repeated, field, value, change)


def test_explicit_baseline_scope_is_supported_and_can_resolve_only_its_field(verified_workflow2):
    sid = "scope-explicit-baseline"
    supported = pipeline.analyze_message(DE_RFQ + " same original material / Germany", session_id=sid)
    assert supported["quote_options"] and supported["mode"] == "options"
    changed = pipeline.apply_instruction(sid, "replace the original material with PVC for the United States market")
    assert_scope_pending(changed, "material", "PVC", "replace the original material with PVC for the United States market")
    one_resolved = pipeline.apply_instruction(sid, "Use the original material again.")
    assert_scope_pending(one_resolved, "market", "US", "replace the original material with PVC for the United States market")
    assert next(row for row in one_resolved["change_order"] if row["field"] == "material")["to"] == "original"
    resolved = pipeline.apply_instruction(sid, "Return to the Germany market only.")
    assert resolved["quote_options"] and resolved["mode"] == "options"


def test_same_material_does_not_clear_previous_pvc(verified_workflow2):
    sid = "scope-same-current-material"
    pipeline.analyze_message(DE_RFQ + " replace the original material with PVC", session_id=sid)
    result = pipeline.analyze_message("Keep the same material and Germany.", session_id=sid)
    assert_scope_pending(result, "material", "PVC", "replace the original material with PVC")


def test_llm_scope_cannot_invent_baseline_confirmation(verified_workflow2, monkeypatch):
    sid = "scope-model-confirmation"
    pipeline.analyze_message(DE_RFQ + " replace the original material with PVC", session_id=sid)
    monkeypatch.setattr("tradetwin.llm.chat_json", lambda *args: {
        "fields": {"material": {"status": "unchanged", "value": "original", "source_quote": "Keep PVC"}}})
    result = pipeline.analyze_message("Keep PVC", session_id=sid)
    assert_scope_pending(result, "material", "PVC", "Keep PVC")


def test_explicit_internal_baseline_aliases_are_supported(verified_workflow2):
    result = pipeline.analyze_message("30W；IP44；DRV-A；材料 original-material；目标市场 DE；2000件",
                                      session_id="scope-internal-baseline")
    assert result["quote_options"] and result["mode"] == "options"
    changes = {row["field"]: row for row in result["change_order"]}
    assert changes["material"]["to"] == "original-material"
    assert changes["market"]["to"] == "DE"


@pytest.mark.parametrize("change", ["Use a different material", "change material to glass fibre composite",
                                   "target market: Canada", "do not use the original material"])
def test_unmapped_explicit_scope_stays_pending(verified_workflow2, change):
    result = pipeline.analyze_message(DE_RFQ + " " + change, session_id="unmapped-" + change)
    assert result["mode"] == "pending_check" and result["quote_options"] == []


def test_incidental_baseline_country_does_not_clear_market_review(verified_workflow2):
    sid = "scope-ambiguous-country"
    pipeline.analyze_message(DE_RFQ + " for the United States market", session_id=sid)
    result = pipeline.analyze_message("Our purchasing colleague is in Germany.", session_id=sid)
    assert_scope_pending(result, "market", "US", "for the United States market")


def test_supported_scope_replay_is_idempotent(verified_workflow2):
    sid = "scope-supported-replay"
    text = DE_RFQ + " same original material / Germany"
    first = pipeline.analyze_message(text, session_id=sid)
    second = pipeline.analyze_message(text, session_id=sid)
    assert second["idempotent_replay"] and second["run_id"] == first["run_id"]


EN_RFQ = "Please quote us 36W IP44 with the same DRV-A driver."
US_REQUEST = "Please quote 36W IP44 with the same DRV-A driver for the United States market"
COLLEAGUE_LOCATION = "Our purchasing colleague for this order is in Germany."


@pytest.mark.parametrize("buyer_text", [EN_RFQ, EN_RFQ + " Please return to us with a quotation."])
def test_quote_us_pronoun_does_not_create_market_hold(verified_workflow2, buyer_text):
    result = pipeline.analyze_message(buyer_text, session_id="scope-pronoun-us")
    assert result["mode"] == "options" and result["quote_options"]
    assert not any(row["field"] == "market" for row in result["change_order"])


@pytest.mark.parametrize("through_instruction", [False, True])
def test_colleague_location_with_for_cannot_clear_market_hold(verified_workflow2, monkeypatch, through_instruction):
    sid = "scope-colleague-location-" + str(through_instruction)
    pipeline.analyze_message(US_REQUEST, session_id=sid)
    evaluate = Mock(wraps=pipeline.workflow2.evaluate)
    monkeypatch.setattr("tradetwin.workflow2.evaluate", evaluate)
    result = (pipeline.apply_instruction(sid, COLLEAGUE_LOCATION + " 只要德语") if through_instruction
              else pipeline.analyze_message(COLLEAGUE_LOCATION, session_id=sid))
    assert_scope_pending(result, "market", "US", US_REQUEST)
    evaluate.assert_not_called()


@pytest.mark.parametrize("separator", ["; ", ", "])
def test_incidental_country_cannot_replace_explicit_market_in_one_message(verified_workflow2, monkeypatch, separator):
    evaluate = Mock(wraps=pipeline.workflow2.evaluate)
    monkeypatch.setattr("tradetwin.workflow2.evaluate", evaluate)
    text = US_REQUEST + separator + COLLEAGUE_LOCATION
    result = pipeline.analyze_message(text, session_id="scope-colleague-initial-" + separator)
    assert_scope_pending(result, "market", "US", US_REQUEST)
    evaluate.assert_not_called()


@pytest.mark.parametrize("market", ["US", "us", "USA", "United States"])
def test_explicit_us_market_aliases_remain_pending(verified_workflow2, market):
    text = EN_RFQ + " Target market: " + market
    result = pipeline.analyze_message(text, session_id="scope-market-alias-" + market)
    assert_scope_pending(result, "market", "US", text)


@pytest.mark.parametrize("confirmation", [
    "Return to the Germany market only.", "Return to Germany.", "Target market: DE.",
    "Zielmarkt: Deutschland.", "目标市场改回德国。",
])
def test_explicit_german_market_return_resolves_hold(verified_workflow2, confirmation):
    sid = "scope-return-" + confirmation
    pipeline.analyze_message(US_REQUEST, session_id=sid)
    result = pipeline.analyze_message(confirmation, session_id=sid)
    assert result["mode"] == "options" and result["quote_options"]
    row = next(row for row in result["change_order"] if row["field"] == "market")
    assert row["to"] == "DE" and row["source_quote"] in confirmation

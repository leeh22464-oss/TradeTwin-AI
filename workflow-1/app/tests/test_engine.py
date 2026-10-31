from fastapi.testclient import TestClient

from tradetwin import checker, extract, mailbox, pipeline
from tradetwin.knowledge import get_kb
from tradetwin.server import app

DE_RFQ = ("Wir möchten die NL-L24 mit 36 Watt statt 24 Watt und IP44 für das Badezimmer. "
          "Den Treiber DRV-A würden wir vorerst beibehalten. Menge: 2000 Stück.")


def options_by_id(result):
    return {o["option_id"]: o for o in result["quote_options"]}


def test_german_rfq_produces_three_options():
    result = pipeline.analyze_message(DE_RFQ, session_id="t-three")
    opts = options_by_id(result)
    assert set(opts) == {"A", "B", "C"}
    assert (opts["A"]["estimated_cost_eur"], opts["A"]["estimated_days"]) == (2100, 8)
    assert (opts["B"]["estimated_cost_eur"], opts["B"]["estimated_days"]) == (3600, 12)
    assert (opts["C"]["estimated_cost_eur"], opts["C"]["estimated_days"]) == (900, 7)
    assert opts["C"]["config"]["power_w"] == 30
    assert opts["B"]["config"]["driver"] != "DRV-A"
    assert all(o["synthetic"] and not o["human_confirmed"] for o in opts.values())
    assert result["status"] == "NEEDS_MANUAL_REVIEW"


def test_findings_carry_evidence_and_emc_is_manual_review():
    result = pipeline.analyze_message(DE_RFQ, session_id="t-evidence")
    by_key = {f["item_key"]: f for f in result["coverage_findings"]}
    assert by_key["thermal_rise"]["status"] == "NEEDS_RETEST"
    assert by_key["emc_electrical"]["status"] == "MANUAL_REVIEW"
    for finding in result["coverage_findings"]:
        assert finding["evidence"], finding["item_key"]


def test_every_extracted_value_has_source_quote():
    data = extract.extract(DE_RFQ, get_kb().product)
    for key, field in data["fields"].items():
        if field["value"] is not None:
            assert field["source_quote"] and extract.quote_in_text(field["source_quote"], DE_RFQ), key


def test_incomplete_request_asks_questions_without_prices():
    result = pipeline.analyze_message("We need a 36W version of NL-L24 for a hotel.", session_id="t-incomplete")
    assert result["status"] == "INPUT_INCOMPLETE"
    assert result["quote_options"] == []
    assert "ip_rating" in [q["key"] for q in result["questions"]]
    assert "EUR" not in result["replies"]["en"]["body"]


def test_idempotent_replay():
    first = pipeline.analyze_message(DE_RFQ, session_id="t-idem")
    second = pipeline.analyze_message(DE_RFQ, session_id="t-idem")
    assert second["idempotent_replay"] and second["run_id"] == first["run_id"]


def test_instruction_selects_option_and_hides_delivery():
    pipeline.analyze_message(DE_RFQ, session_id="t-instr")
    result = pipeline.apply_instruction("t-instr", "选方案C，先不要承诺交期")
    assert result["mode"] == "confirm_selected" and result["selected_option_id"] == "C"
    assert result["constraints"]["hide_delivery_date"]
    for reply in result["replies"].values():
        assert reply["check"]["counts"]["high"] == 0
    only_de = pipeline.apply_instruction("t-instr", "只要德语")
    assert list(only_de["replies"]) == ["de"] and only_de["selected_option_id"] == "C"


def test_generated_replies_pass_checker():
    result = pipeline.analyze_message(DE_RFQ, session_id="t-clean")
    for reply in result["replies"].values():
        assert reply["check"]["level"] != "red", reply["check"]["annotations"]


def test_checker_flags_wrong_number_and_claims():
    pipeline.analyze_message(DE_RFQ, session_id="t-check")
    text = "Good news: option A costs EUR 1,999 and the product is fully compliant and CE certified."
    result = pipeline.check_reply(text, "t-check")
    cats = {a["category"] for a in result["annotations"]}
    assert result["level"] == "red"
    assert {"NUMBER_MISMATCH", "UNSUPPORTED_CLAIM"} <= cats


def test_checker_platform_rule_on_rfq_channel():
    result = checker.check("Please contact me on WhatsApp +49 170 1234567", {}, "alibaba_rfq", {})
    assert "PLATFORM_RULE" in {a["category"] for a in result["annotations"]}


def test_amount_parsing():
    assert checker.parse_amount("1.200,50") == 1200.5
    assert checker.parse_amount("1,200.50") == 1200.5
    assert checker.parse_amount("11,59") == 11.59
    assert checker.parse_amount("1200") == 1200


def test_strip_quoted_and_subject():
    body = "Option C passt.\n\nAm 30.10.2026 schrieb NordLuma Sales:\n> Option A"
    assert mailbox.strip_quoted(body) == "Option C passt."
    assert mailbox.normalize_subject("AW: Re: Anfrage X") == "anfrage x"


def test_offline_mail_flow_end_to_end():
    client = TestClient(app)
    assert client.post("/api/mail/reset").status_code == 200
    threads = client.get("/api/mail/threads?refresh=true").json()["threads"]
    assert len(threads) == 3
    de = next(t for t in threads if "36 W" in t["subject"])

    first = client.post("/api/mail/analyze", json={"thread_id": de["thread_id"]}).json()
    assert {o["option_id"] for o in first["quote_options"]} == {"A", "B", "C"}

    draft = client.post("/api/mail/draft", json={"thread_id": de["thread_id"], "language": "de"})
    assert draft.status_code == 200, draft.text
    assert draft.json()["mode"] == "offline"

    assert client.post("/api/mail/simulate-reply", json={"thread_id": de["thread_id"]}).status_code == 200
    second = client.post("/api/mail/analyze", json={"thread_id": de["thread_id"]}).json()
    assert second["round"] == 2 and second["selected_option_id"] == "C"

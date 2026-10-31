"""第四步：把已算好的方案事实写成买家语言的回复。模板保证稳定，模型只负责润色。"""

import json

from . import llm

QUESTIONS = {
    "power_w": {
        "zh": "最终版本需要的额定功率是多少？",
        "en": "Which rated power is required for the final version?",
        "de": "Welche Nennleistung ist für die endgültige Ausführung erforderlich?",
    },
    "ip_rating": {
        "zh": "最终版本需要的防护等级（IP）是多少？",
        "en": "Which IP rating is required for the final version?",
        "de": "Welche Schutzart (IP) ist für die endgültige Ausführung erforderlich?",
    },
    "driver": {
        "zh": "是否沿用当前驱动电源 DRV-A，还是需要更换？",
        "en": "Can the current driver DRV-A be retained, or is a different driver required?",
        "de": "Kann der bisherige Treiber DRV-A beibehalten werden, oder wird ein anderer Treiber benötigt?",
    },
    "installation": {
        "zh": "灯具的安装位置是哪里（例如浴室区域、潮湿场所）？",
        "en": "Where will the luminaire be installed (e.g. bathroom zone or damp location)?",
        "de": "Wo wird die Leuchte installiert (z. B. Badezimmerbereich oder Feuchtraum)?",
    },
    "quantity": {
        "zh": "报价按多少订单数量计算？",
        "en": "Which order quantity should we base the offer on?",
        "de": "Auf welche Bestellmenge sollen wir das Angebot beziehen?",
    },
}

DOC_NAMES = {
    "DoC": {"en": "Declaration of Conformity", "de": "EU-Konformitätserklärung"},
    "label": {"en": "label", "de": "Kennzeichnung"},
    "German instructions": {"en": "German instructions", "de": "deutsche Anleitung"},
}

TEXT = {
    "en": {
        "greet_name": "Dear {name},",
        "greet": "Dear Sir or Madam,",
        "greet_rfq_name": "Hi {name},",
        "greet_rfq": "Hello,",
        "intro": "Thank you for your request regarding the {cfg} version of {model}.",
        "checked": ("We have checked which of our existing compliance evidence for the current {base} configuration "
                    "can be reused and which additional tests would be required. Please find our options below. "
                    "All figures are preliminary estimates and subject to confirmation by our engineering team and the test laboratory."),
        "rfq_intro": "Thanks for your request for the {cfg} version. Our options (preliminary estimates, subject to engineering and lab confirmation):",
        "tests": "Additional tests: {tests}",
        "no_tests": "Additional tests: none expected based on our existing test report",
        "docs": "Documentation to be updated: {docs}",
        "price": "Estimated unit price: {price} ({qty})",
        "lead": "Estimated lead time: {days} working days",
        "lead_hidden": "Lead time: to be confirmed after laboratory scheduling",
        "emc_note": "Reuse of the existing EMC results is expected, subject to engineering confirmation.",
        "ask": "Before we finalise the offer, could you please confirm:",
        "rfq_ask": "Please confirm:",
        "close": "Please let us know which option you prefer, and we will send you the binding offer.",
        "rfq_close": "Which option works best for you?",
        "regards": "Best regards",
        "incomplete": ("Thank you for your request. To check which of our existing compliance evidence can be reused "
                       "and to prepare a reliable estimate, we need a few more details:"),
        "incomplete_close": "As soon as we have this information, we will send you our options.",
        "no_change": ("The requested configuration corresponds to our current {base} version, which is covered by our "
                      "existing test report. Preliminary estimate, subject to confirmation:"),
        "selected": "Thank you for choosing Option {oid} ({cfg}).",
        "selected_next": ("As next steps, we will arrange the required work with our engineering team and the test laboratory. "
                          "The figures below remain preliminary estimates until the test plan is confirmed:"),
        "selected_close": "We will send you the binding offer as soon as the test plan is confirmed.",
        "subject_new": "{model} {cfg} – options (preliminary estimate)",
        "re": "Re: ",
        "option": "Option {oid} – {title}",
        "kind_requested": "as requested: {cfg}, driver {driver}",
        "kind_new_driver": "{cfg} with a new driver",
        "kind_within_coverage": "{cfg} with power within our existing thermal test range",
        "qty": "{qty} pcs",
        "test_fallback": "additional test ({key})",
        "pending": ("Thank you for your request regarding the {cfg} version. Our quality team is currently checking which "
                    "of our existing compliance evidence can be reused and which additional tests would be needed."),
        "pending_close": "We will send you our options with preliminary price and lead time as soon as this check is complete.",
        "join": ", ",
    },
    "de": {
        "greet_name": "Guten Tag {name},",
        "greet": "Sehr geehrte Damen und Herren,",
        "greet_rfq_name": "Guten Tag {name},",
        "greet_rfq": "Guten Tag,",
        "intro": "vielen Dank für Ihre Anfrage zur Ausführung {cfg} des Modells {model}.",
        "checked": ("Wir haben geprüft, welche unserer vorhandenen Nachweise für die aktuelle Konfiguration {base} "
                    "weiterverwendet werden können und welche zusätzlichen Prüfungen erforderlich wären. Nachfolgend finden Sie "
                    "unsere Optionen. Alle Angaben sind vorläufige Schätzungen, vorbehaltlich der Bestätigung durch unsere Technik und das Prüflabor."),
        "rfq_intro": "vielen Dank für Ihre Anfrage zur Ausführung {cfg}. Unsere Optionen (vorläufige Schätzungen, vorbehaltlich Bestätigung durch Technik und Prüflabor):",
        "tests": "Zusätzliche Prüfungen: {tests}",
        "no_tests": "Zusätzliche Prüfungen: nach unserem vorhandenen Prüfbericht voraussichtlich keine",
        "docs": "Zu aktualisierende Unterlagen: {docs}",
        "price": "Geschätzter Stückpreis: {price} ({qty})",
        "lead": "Geschätzte Lieferzeit: {days} Arbeitstage",
        "lead_hidden": "Lieferzeit: wird nach Terminierung durch das Prüflabor bestätigt",
        "emc_note": "Die vorhandenen EMV-Ergebnisse können voraussichtlich weiterverwendet werden; die Bestätigung durch unsere Technik steht noch aus.",
        "ask": "Bevor wir das Angebot fertigstellen, bitten wir Sie um Bestätigung folgender Punkte:",
        "rfq_ask": "Bitte bestätigen Sie:",
        "close": "Bitte teilen Sie uns mit, welche Option Sie bevorzugen; anschließend senden wir Ihnen das verbindliche Angebot.",
        "rfq_close": "Welche Option passt am besten für Sie?",
        "regards": "Mit freundlichen Grüßen",
        "incomplete": ("vielen Dank für Ihre Anfrage. Um zu prüfen, welche unserer vorhandenen Nachweise weiterverwendet werden können, "
                       "und um eine belastbare Schätzung zu erstellen, benötigen wir noch einige Angaben:"),
        "incomplete_close": "Sobald uns diese Informationen vorliegen, senden wir Ihnen unsere Optionen.",
        "no_change": ("die angefragte Konfiguration entspricht unserer aktuellen Ausführung {base}, die durch unseren vorhandenen "
                      "Prüfbericht abgedeckt ist. Vorläufige Schätzung, vorbehaltlich Bestätigung:"),
        "selected": "vielen Dank, dass Sie sich für Option {oid} ({cfg}) entschieden haben.",
        "selected_next": ("Als nächste Schritte stimmen wir die erforderlichen Arbeiten mit unserer Technik und dem Prüflabor ab. "
                          "Die folgenden Angaben bleiben vorläufige Schätzungen, bis der Prüfplan bestätigt ist:"),
        "selected_close": "Sobald der Prüfplan bestätigt ist, senden wir Ihnen das verbindliche Angebot.",
        "subject_new": "{model} {cfg} – Optionen (vorläufige Schätzung)",
        "re": "AW: ",
        "option": "Option {oid} – {title}",
        "kind_requested": "wie angefragt: {cfg}, Treiber {driver}",
        "kind_new_driver": "{cfg} mit neuem Treiber",
        "kind_within_coverage": "{cfg} mit Leistung innerhalb unseres bestehenden thermischen Prüfbereichs",
        "qty": "{qty} Stück",
        "test_fallback": "zusätzliche Prüfung ({key})",
        "pending": ("vielen Dank für Ihre Anfrage zur Ausführung {cfg}. Unser Qualitätsteam prüft derzeit, welche unserer "
                    "vorhandenen Nachweise weiterverwendet werden können und welche zusätzlichen Prüfungen erforderlich wären."),
        "pending_close": "Sobald diese Prüfung abgeschlossen ist, senden wir Ihnen unsere Optionen mit vorläufigem Preis und Lieferzeit.",
        "join": ", ",
    },
}


def money(value: float, lang: str) -> str:
    if lang == "de":
        return f"{value:,.2f}".replace(",", "X").replace(".", ",").replace("X", ".") + " EUR"
    return f"EUR {value:,.2f}"


def integer(value: int, lang: str) -> str:
    text = f"{value:,}"
    return text.replace(",", ".") if lang == "de" else text


def cfg_text(config: dict) -> str:
    return f"{config['power_w']} W / {config['ip_rating']}"


def test_names(option: dict, lang: str) -> str:
    names = []
    details = option["coverage"].get("retest_details", {})
    for key in option["retest_items"]:
        name = details.get(key, {}).get("name", {}).get(lang) or TEXT[lang]["test_fallback"].format(key=key)
        if key == "ingress_protection":
            name += f" ({option['config']['ip_rating']})"
        names.append(name)
    return TEXT[lang]["join"].join(names)


def emc_review_pending(option: dict) -> bool:
    return any(f["item_key"] == "emc_electrical" and f["status"] == "MANUAL_REVIEW"
               for f in option["coverage"]["findings"])


def option_lines(option: dict, lang: str, facts: dict) -> list[str]:
    t = TEXT[lang]
    lines = [t["tests"].format(tests=test_names(option, lang)) if option["retest_items"] else t["no_tests"]]
    updates = option["coverage"]["document_updates"]
    if updates:
        lines.append(t["docs"].format(docs=t["join"].join(DOC_NAMES.get(u, {}).get(lang, u) for u in updates)))
    if option.get("unit_price_eur") is not None:
        lines.append(t["price"].format(price=money(option["unit_price_eur"], lang),
                                       qty=t["qty"].format(qty=integer(option["quantity"], lang))))
    else:
        lines.append("Price and lead time: to be confirmed after quality review" if lang == "en"
                     else "Preis und Lieferzeit: werden nach der Qualitätsprüfung bestätigt")
    if not facts["constraints"].get("hide_delivery_date") and option.get("lead_time_working_days") is not None:
        lines.append(t["lead"].format(days=option["lead_time_working_days"]))
    if emc_review_pending(option):
        lines.append(t["emc_note"])
    return lines


def option_title(option: dict, lang: str) -> str:
    t = TEXT[lang]
    title = t["kind_" + option["kind"]].format(cfg=cfg_text(option["config"]), driver=option["config"]["driver"])
    return t["option"].format(oid=option["option_id"], title=title)


def render_template(lang: str, facts: dict) -> dict:
    t = TEXT[lang]
    rfq = facts["channel"] == "alibaba_rfq"
    name = facts.get("buyer_name")
    base = facts["baseline"]
    model = base["model"]
    mode = facts["mode"]
    options = facts["options"]
    lead_cfg = cfg_text(options[0]["config"]) if options else cfg_text(facts.get("requested_config", base))

    if rfq:
        greet = t["greet_rfq_name"].format(name=name) if name else t["greet_rfq"]
    else:
        greet = t["greet_name"].format(name=name) if name else t["greet"]
    out = [greet, ""]

    questions = [QUESTIONS[q][lang] for q in facts["questions"]]

    if mode == "incomplete":
        out.append(t["incomplete"])
        out += [f"{i}. {q}" for i, q in enumerate(questions, 1)]
        out += ["", t["incomplete_close"]]
    elif mode == "confirm_selected":
        opt = facts["selected_option"]
        out.append(t["selected"].format(oid=opt["option_id"], cfg=cfg_text(opt["config"])))
        out.append(t["selected_next"])
        out += [f"- {line}" for line in option_lines(opt, lang, facts)]
        out += ["", t["selected_close"]]
    elif mode == "pending_check":
        out.append(t["pending"].format(cfg=lead_cfg))
        if questions:
            out += ["", t["ask"]] + [f"{i}. {q}" for i, q in enumerate(questions, 1)]
        out += ["", t["pending_close"]]
    else:
        if mode == "no_change":
            out.append(t["no_change"].format(base=cfg_text(base)))
        elif rfq:
            out.append(t["rfq_intro"].format(cfg=lead_cfg))
        else:
            out.append(t["intro"].format(cfg=lead_cfg, model=model))
            out += ["", t["checked"].format(base=cfg_text(base))]
        for opt in options:
            lines = option_lines(opt, lang, facts)
            if rfq:
                out.append(f"• {option_title(opt, lang)}: " + "; ".join(lines))
            else:
                out += ["", option_title(opt, lang)] + [f"- {line}" for line in lines]
        if questions:
            if rfq:
                out.append(t["rfq_ask"] + " " + " ".join(f"({i}) {q}" for i, q in enumerate(questions, 1)))
            else:
                out += ["", t["ask"]] + [f"{i}. {q}" for i, q in enumerate(questions, 1)]
        out += ["", t["rfq_close"] if rfq else t["close"]]

    if not rfq:
        out += ["", t["regards"], facts.get("signature", "")]
    body = "\n".join(out).strip() + "\n"

    subject = facts.get("subject")
    if subject:
        if not subject.lower().startswith(("re:", "aw:", "antw:")):
            subject = t["re"] + subject
    else:
        subject = t["subject_new"].format(model=model, cfg=lead_cfg)
    return {"subject": subject, "body": body}


WRITER_PROMPT = """你是资深外贸业务员，为欧盟室内 LED 灯具业务撰写给买家的回复。
你会收到一份参考草稿和事实 JSON。请在不改变任何事实的前提下，把草稿改写得更自然、专业。
硬性规则：
1. 不得新增、删除或修改任何数字（价格、天数、功率、数量、方案编号），不得新增方案。
2. 不得写“已认证 / certified / zertifiziert / guaranteed / garantiert / fully compliant”等承诺；DoC 不能称为证书（certificate/Zertifikat）。
3. 必须保留“预估、待工程和实验室确认”的含义；保留全部待确认问题。
4. 德语使用 Sie 尊称，表达直接精确；英语礼貌中性，避免中式英语。
5. channel=alibaba_rfq 时保持简短分点，不写邮箱、电话、网址或其他站外联系方式；channel=email 时保留称呼和落款。
6. constraints.hide_delivery_date=true 时不得出现任何交期天数或日期。
返回 JSON：{"subject": "...", "body": "..."}"""


def polish(lang: str, draft: dict, facts: dict) -> dict | None:
    brief = {
        "language": lang,
        "channel": facts["channel"],
        "constraints": facts["constraints"],
        "reference_draft": draft,
    }
    data = llm.chat_json(WRITER_PROMPT, json.dumps(brief, ensure_ascii=False), temperature=0.4)
    if not data or not isinstance(data.get("body"), str) or not data["body"].strip():
        return None
    return {"subject": str(data.get("subject") or draft["subject"]), "body": data["body"].strip() + "\n"}

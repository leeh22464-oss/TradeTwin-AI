"""第五步：发送前校验（确定性规则）。同时服务于“AI 起草”和“我写 AI 审”两种模式。"""

import re

AMOUNT = r"\d{1,3}(?:[.,]\d{3})+(?:[.,]\d{1,2})?|\d+(?:[.,]\d{1,2})?"
MONEY_RE = re.compile(rf"(?:EUR|€)\s?({AMOUNT})|({AMOUNT})\s?(?:EUR|€|欧元)", re.I)
DAYS_RE = re.compile(r"(\d{1,3})\s*(?:working days|business days|days|Arbeitstagen?|Werktagen?|Tagen?|个工作日|工作日|天)", re.I)
WATT_RE = re.compile(r"(\d{1,3})\s*-?\s*(?:watts?\b|w(?![a-zäöüß]))", re.I)
DATE_RE = re.compile(r"\b\d{4}-\d{2}-\d{2}\b|\b(?:KW|CW)\s?\d{1,2}\b", re.I)
EMAIL_RE = re.compile(r"[\w.+-]+@[\w-]+\.[\w.-]+")
URL_RE = re.compile(r"https?://\S+|www\.\S+", re.I)
PHONE_RE = re.compile(r"\+?\d[\d\s()-]{7,}\d")
IM_RE = re.compile(r"whatsapp|wechat|微信|skype|telegram", re.I)
DISCLAIMER_RE = re.compile(
    r"estimate|preliminary|subject to|approx|schätzung|geschätzt|vorläufig|vorbehaltlich|\bca\.|预估|估算|待确认|约", re.I)
NO_TEST_CLAIM_RE = re.compile(
    r"no (?:additional |further )?tests? (?:is |are )?(?:needed|required)|keine (?:zusätzlichen |weiteren )?Prüfungen (?:erforderlich|nötig|notwendig)|无需补测|不需要补测", re.I)

CLAIMS = [
    (re.compile(r"CE[- ]?(?:approved|approval|certified|zertifiziert)", re.I), "high",
     "不得声称 CE 已批准或已认证：CE 是制造商自我声明，且当前证据尚未覆盖新配置。", "PROMPT-CONTEXT 明确拒绝的推断"),
    (re.compile(r"\bcertified\b|\bzertifiziert\b|已认证|已通过认证", re.I), "high",
     "未经检测机构和工程确认，不得声称产品已认证。", "PROMPT-CONTEXT 明确拒绝的推断"),
    (re.compile(r"\bcertificates?\b|\bZertifikate?\b|证书", re.I), "medium",
     "DoC 是符合性声明，不是证书；建议改为 Declaration of Conformity / EU-Konformitätserklärung。", "TERM-DOC"),
    (re.compile(r"fully compliant|vollständig konform|完全合规|100\s?%", re.I), "high",
     "绝对化合规表述没有证据支撑。", "RULE-COVERAGE-RANGE-001"),
    (re.compile(r"\bguarantee[ds]?\b|\bgarantier\w*|保证", re.I), "high",
     "费用和交期为合成估算，未经采购/实验室确认，不能作出保证。", "RULE-QUOTE-ASSUMPTION-001"),
]


def parse_amount(raw: str) -> float:
    """兼容 2,100 / 2.100 / 11.59 / 11,59：分隔符后恰好三位视为千分位。"""
    raw = raw.strip()
    seps = [i for i, c in enumerate(raw) if c in ".,"]
    if not seps:
        return float(raw)
    last = seps[-1]
    if len(raw) - last - 1 == 3:
        return float(re.sub(r"[.,]", "", raw))
    return float(re.sub(r"[.,]", "", raw[:last]) + "." + raw[last + 1:])


def _ann(category, severity, match, message, basis, group=0) -> dict:
    return {
        "category": category,
        "severity": severity,
        "start": match.start(group),
        "end": match.end(group),
        "text": match.group(group),
        "message": message,
        "basis": basis,
    }


def check(text: str, facts: dict | None = None, channel: str = "email", constraints: dict | None = None) -> dict:
    facts = facts or {}
    constraints = constraints or {}
    notes: list[dict] = []

    money_allowed = {round(v, 2) for v in facts.get("money", [])}
    days_allowed = set(facts.get("days", []))
    watts_allowed = set(facts.get("watts", []))
    has_numbers = False

    for m in MONEY_RE.finditer(text):
        has_numbers = True
        group = 1 if m.group(1) else 2
        value = round(parse_amount(m.group(group)), 2)
        if "money" in facts and value not in money_allowed:
            notes.append(_ann("NUMBER_MISMATCH", "high", m,
                              f"金额 {m.group(group)} 与系统计算的方案不一致。", "方案事实 / RULE-QUOTE-ASSUMPTION-001"))

    for m in DAYS_RE.finditer(text):
        has_numbers = True
        if constraints.get("hide_delivery_date"):
            notes.append(_ann("CONSTRAINT_VIOLATION", "high", m,
                              "已要求暂不承诺交期，回复中不应出现交期天数。", "业务员指令"))
        elif "days" in facts and int(m.group(1)) not in days_allowed:
            notes.append(_ann("NUMBER_MISMATCH", "high", m,
                              f"天数 {m.group(1)} 与系统计算的交期不一致。", "方案事实 / RULE-QUOTE-ASSUMPTION-001"))

    for m in WATT_RE.finditer(text):
        if watts_allowed and int(m.group(1)) not in watts_allowed:
            notes.append(_ann("NUMBER_MISMATCH", "high", m,
                              f"功率 {m.group(1)}W 不属于当前任何方案或报告覆盖范围。", "变更单 / RULE-RATED-POWER-001"))

    if constraints.get("hide_delivery_date"):
        for m in DATE_RE.finditer(text):
            notes.append(_ann("CONSTRAINT_VIOLATION", "high", m,
                              "已要求暂不承诺交期，回复中不应出现具体日期或周次。", "业务员指令"))

    for pattern, severity, message, basis in CLAIMS:
        for m in pattern.finditer(text):
            notes.append(_ann("UNSUPPORTED_CLAIM", severity, m, message, basis))

    if facts.get("retest_required_all"):
        for m in NO_TEST_CLAIM_RE.finditer(text):
            notes.append(_ann("UNSUPPORTED_CLAIM", "high", m,
                              "所有方案都需要补测，不能告诉买家无需测试。", "RULE-COVERAGE-RANGE-001"))

    if has_numbers and not DISCLAIMER_RE.search(text):
        notes.append({"category": "MISSING_DISCLAIMER", "severity": "medium", "start": 0, "end": 0, "text": "",
                      "message": "回复包含金额或交期，但没有说明是预估、待工程和实验室确认。",
                      "basis": "RULE-QUOTE-ASSUMPTION-001"})

    if channel == "alibaba_rfq":
        for regex, label in ((EMAIL_RE, "邮箱"), (URL_RE, "站外链接"), (PHONE_RE, "电话号码"), (IM_RE, "站外即时通讯")):
            for m in regex.finditer(text):
                notes.append(_ann("PLATFORM_RULE", "medium", m,
                                  f"国际站 RFQ 回复中出现{label}，存在引导站外交易的风险。",
                                  "PLATFORM-ALIBABA-CONTACT（演示规则，以阿里国际站帮助中心为准）"))

    notes.sort(key=lambda n: (n["start"], n["end"]))
    counts = {s: sum(1 for n in notes if n["severity"] == s) for s in ("high", "medium", "low")}
    level = "red" if counts["high"] else "yellow" if counts["medium"] else "green"
    return {"level": level, "counts": counts, "annotations": notes}

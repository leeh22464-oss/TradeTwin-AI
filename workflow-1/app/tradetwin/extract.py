"""第一步：从买家消息中抽取变更（模型优先，规则兜底），每个字段必须能回到原文。"""

import json
import re

from . import llm

POWER_RE = re.compile(r"(\d{1,3}(?:[.,]\d)?)\s*-?\s*(?:watts?\b|瓦|w(?![a-zäöüß]))", re.I)
IP_RE = re.compile(r"\bIP\s?-?(\d{2})\b", re.I)
DRV_RE = re.compile(r"\bDRV-?([A-Z0-9]{1,6})\b")
NEW_DRIVER_RE = re.compile(
    r"(?:new|different|another|other)\s+driver|neue[nrsm]?\s+Treiber|anderen?\s+Treiber|更换驱动|换驱动|新驱动", re.I)
DRIVER_WORD_RE = re.compile(r"driver|treiber|驱动|DRV", re.I)
TENTATIVE_RE = re.compile(r"for now|currently|vorerst|zunächst|derzeit|eventuell|may change|might change|暂|暂时|可能更换", re.I)
HOUSING_SAME_RE = re.compile(r"same housing|gleiche[ns]?\s+Gehäuse|外壳不变|同款外壳|同样的外壳", re.I)
DRIVER_SAME_RE = re.compile(r"same driver|keep (?:the )?driver|gleiche[nr]?\s+Treiber|Treiber beibehalten|驱动不变|沿用驱动", re.I)
ALL_SAME_RE = re.compile(r"otherwise unchanged|everything else (?:stays )?(?:the )?same|sonst unverändert|ansonsten unverändert|其他不变|其余不变", re.I)
QTY_RE = re.compile(r"(\d{1,3}(?:[.,\u00a0 ]\d{3})+|\d+)\s*(?:pcs|pc|pieces|units|stück|stk\.?|件|台|套|只)", re.I)
DELIVERY_RE = re.compile(r"(?:KW|CW|week|Woche)\s?\d{1,2}|\d{1,2}\s*(?:weeks|wochen|周)|\d{4}-\d{2}-\d{2}", re.I)
INSTALL_RE = re.compile(r"bathroom|badezimmer|feuchtraum|damp location|wet location|outdoor|außenbereich|浴室|卫生间|潮湿|户外", re.I)
OPTION_RE = re.compile(r"(?:option|variante|方案)\s*([ABC])\b", re.I)
CJK_RE = re.compile(r"[\u4e00-\u9fff]")
DE_RE = re.compile(r"[äöüß]|\b(?:bitte|und|wir|Sie|Stück|Angebot|Grüße|statt|für|Ausführung)\b", re.I)
SENTENCE_RE = re.compile(r"[^.!?。！？\n]+")

TECH_FIELDS = ("power_w", "ip_rating", "driver")
EXTRA_FIELDS = ("quantity", "delivery", "installation")
SCOPE_FIELDS = ("material", "market")  # Preserved locally; outside the restricted WF2 v1 config contract.
MATERIAL_TOKEN_RE = re.compile(r"(?<![A-Za-z])(?:PVC|ABS|polycarbonate|silicone|alumin(?:i)?um|steel)(?![A-Za-z])", re.I)
MATERIAL_WORD_RE = re.compile(r"\bmaterials?\b|\bWerkstoff\w*|\bMaterial\w*|材料|材质", re.I)
ORIGINAL_MATERIAL_RE = re.compile(
    r"\boriginal-material\b|\b(?:same\s+)?(?:original|baseline)\s+materials?\b|"
    r"\b(?:ursprünglich\w*|Original)\s*material\w*|(?:原(?:来|始)?材料|原材质|原材料组合)(?:不变)?", re.I)
SAME_MATERIAL_RE = re.compile(r"\bsame\s+materials?\b|\bgleich\w*\s+Material\w*|材料不变|材质不变", re.I)
SCOPE_NEGATION_RE = re.compile(r"\b(?:not|no|without|nicht|kein\w*)\b|不要|不再|不用|不使用", re.I)
MARKET_WORD_RE = re.compile(r"\b(?:target\s+)?market\b|\bZielmarkt\b|\bMarkt\b|目标市场|市场|销往|出口到", re.I)
COUNTRY_RE = re.compile(
    r"\bUnited States\b|\bUSA\b|\bUS\b|\bU\.S\.(?:A\.)?|\bVereinigte[n]? Staaten\b|美国|"
    r"\bGermany\b|\bDeutschland\b|德国|\bDE\b|\bCanada\b|加拿大|\bKanada\b|"
    r"\bFrance\b|法国|\bFrankreich\b|\bUnited Kingdom\b|\bUK\b|英国|\bChina\b|中国", re.I)
MARKET_PREFIX_RE = re.compile(
    r"(?:\b(?:target\s+)?market\b|\bZielmarkt\b|\bMarkt\b|目标市场|市场)"
    r"\s*(?:(?:is|remains|to|back to|ist|bleibt|auf|改为|改回|恢复为|为|是)\s*)?[:：=-]?\s*(?:the\s+)?$", re.I)
MARKET_SUFFIX_RE = re.compile(r"^\s*(?:market\b|Markt\b|市场)", re.I)
MARKET_RETURN_RE = re.compile(
    r"\b(?:return|back)\s+to\s+(?:the\s+)?$|"
    r"\b(?:ship|export|sell)\s+to\s+(?:the\s+)?$|销往\s*$|出口到\s*$|改回\s*$|恢复\s*$", re.I)


def scope_fields(text: str) -> dict:
    """Retain explicit scope facts; only explicit original-material / German scope confirms baseline."""
    result = {}
    # Clause boundaries keep a negation about one scope field from resolving a different field.
    clauses = re.split(r"[.!?。！？;；\n]+", text)
    for clause in clauses:
        token = MATERIAL_TOKEN_RE.search(clause)
        word = MATERIAL_WORD_RE.search(clause)
        original = ORIGINAL_MATERIAL_RE.search(clause)
        negated = bool(SCOPE_NEGATION_RE.search(clause))
        if token:
            value = token.group(0).upper() if token.group(0).upper() in ("PVC", "ABS") else token.group(0)
            result["material"] = {"value": value, "status": "changed", "source_quote": token.group(0)}
        elif original and not negated:
            value = "original-material"
            result["material"] = {"value": value, "status": "unchanged", "source_quote": original.group(0)}
        elif word and not (SAME_MATERIAL_RE.search(clause) and not negated):
            result["material"] = {"value": clause.strip(), "status": "changed", "source_quote": clause.strip()}

        # Bind context to each country, rather than treating any "for" / "market"
        # elsewhere in the clause as confirmation. This also excludes the pronoun "us".
        countries = []
        for match in COUNTRY_RE.finditer(clause):
            before, after = clause[:match.start()], clause[match.end():]
            market_context = bool(MARKET_PREFIX_RE.search(before) or MARKET_SUFFIX_RE.search(after))
            # "return to us" is still a pronoun; lowercase US needs a market label.
            destination = bool(MARKET_RETURN_RE.search(before) and match.group(0) != "us")
            explicit = market_context or destination
            # Retain the supported original-material / Germany shorthand without
            # allowing a bare country to resolve an earlier explicit market hold.
            shorthand = bool(original and before.rstrip().endswith("/") and not after.strip()
                             and not countries and "market" not in result)
            if explicit or shorthand:
                countries.append((match, explicit))
        if countries:
            country, explicit = countries[-1]
            name = country.group(0)
            german = name.lower() in ("germany", "deutschland", "de", "德国")
            united_states = name.lower() in ("united states", "usa", "us", "u.s.", "u.s.a.",
                                            "vereinigte staaten", "vereinigten staaten", "美国")
            value = "DE" if german else "US" if united_states else name
            result["market"] = {"value": value, "status": "unchanged" if german and not negated else "changed",
                                "source_quote": name,
                                "baseline_confirmed": bool(german and not negated and explicit)}
        elif MARKET_WORD_RE.search(clause):
            result["market"] = {"value": clause.strip(), "status": "changed", "source_quote": clause.strip()}
    return result

SYSTEM_PROMPT = """你是外贸订单变更抽取器，服务欧盟室内固定式 LED 灯具业务。
只抽取买家明确提出的内容，不推测、不补全。每个有值的字段必须给出 source_quote：买家原文中逐字出现的片段。
返回 JSON，结构如下：
{
  "language": "de|en|zh",
  "fields": {
    "power_w": {"status": "changed|unchanged|unknown", "value": 数字或null, "source_quote": "原文或null"},
    "ip_rating": {"status": "changed|unchanged|unknown", "value": "IPxx或null", "source_quote": "原文或null"},
    "driver": {"status": "changed|unchanged|tentative|unknown", "value": "驱动型号或DRV-NEW或null", "source_quote": "原文或null"},
    "quantity": {"value": 整数或null, "source_quote": "原文或null"},
    "delivery": {"value": "交期原文或null", "source_quote": "原文或null"},
    "installation": {"value": "安装环境或null", "source_quote": "原文或null"},
    "material": {"status": "changed|unchanged|unknown", "value": "材料或null", "source_quote": "原文或null"},
    "market": {"status": "changed|unchanged|unknown", "value": "目标国家或null", "source_quote": "原文或null"}
  },
  "selected_option": "A|B|C|null"
}
规则：
- status=changed 表示买家要求的值与当前配置不同；unchanged 表示买家明确说保持不变或给出的值与当前配置相同；unknown 表示没有提到。
- driver：买家说暂时/目前保持某驱动、但可能更换时用 tentative；要求换新驱动但没给型号时 value 用 DRV-NEW。
- selected_option：买家明确选择了报价中的方案 A/B/C 时填写。"""


def detect_language(text: str) -> str:
    if len(CJK_RE.findall(text)) > 5:
        return "zh"
    if len(DE_RE.findall(text)) >= 2:
        return "de"
    return "en"


def _normalize(s: str) -> str:
    return re.sub(r"\s+", " ", s).strip().lower()


def quote_in_text(quote: str | None, text: str) -> bool:
    return bool(quote) and _normalize(quote) in _normalize(text)


def _empty_fields() -> dict:
    fields = {key: {"status": "unknown", "value": None, "source_quote": None} for key in TECH_FIELDS}
    fields.update({key: {"value": None, "source_quote": None} for key in EXTRA_FIELDS})
    fields.update({key: {"status": "unknown", "value": None, "source_quote": None} for key in SCOPE_FIELDS})
    return fields


def _pick(candidates: list[tuple], baseline) -> tuple | None:
    if not candidates:
        return None
    others = [c for c in candidates if c[0] != baseline]
    return others[-1] if others else candidates[-1]


def rule_extract(text: str, baseline: dict) -> dict:
    fields = _empty_fields()

    powers = [(int(float(m.group(1).replace(",", "."))), m.group(0)) for m in POWER_RE.finditer(text)]
    hit = _pick(powers, baseline["rated_power_w"])
    if hit:
        fields["power_w"] = {"status": "changed" if hit[0] != baseline["rated_power_w"] else "unchanged",
                             "value": hit[0], "source_quote": hit[1]}

    ips = [(f"IP{m.group(1)}", m.group(0)) for m in IP_RE.finditer(text)]
    hit = _pick(ips, baseline["protection_rating"])
    if hit:
        fields["ip_rating"] = {"status": "changed" if hit[0] != baseline["protection_rating"] else "unchanged",
                               "value": hit[0], "source_quote": hit[1]}

    new_driver = NEW_DRIVER_RE.search(text)
    drivers = [(f"DRV-{m.group(1)}", m.group(0)) for m in DRV_RE.finditer(text)]
    hit = _pick(drivers, baseline["driver_model"])
    driver_sentence = next((s for s in SENTENCE_RE.findall(text) if DRIVER_WORD_RE.search(s)), "")
    tentative = bool(TENTATIVE_RE.search(driver_sentence))
    if hit and hit[0] != baseline["driver_model"]:
        fields["driver"] = {"status": "changed", "value": hit[0], "source_quote": hit[1]}
    elif new_driver and not tentative:
        fields["driver"] = {"status": "changed", "value": "DRV-NEW", "source_quote": new_driver.group(0)}
    elif hit or new_driver:
        quote = hit[1] if hit else new_driver.group(0)
        fields["driver"] = {"status": "tentative" if tentative else "unchanged",
                            "value": baseline["driver_model"], "source_quote": quote}

    all_same = ALL_SAME_RE.search(text)
    housing_same = HOUSING_SAME_RE.search(text) or all_same
    driver_same = DRIVER_SAME_RE.search(text) or all_same
    if housing_same and fields["ip_rating"]["status"] == "unknown":
        fields["ip_rating"] = {"status": "unchanged", "value": baseline["protection_rating"],
                               "source_quote": housing_same.group(0)}
    if driver_same and fields["driver"]["status"] == "unknown":
        fields["driver"] = {"status": "unchanged", "value": baseline["driver_model"],
                            "source_quote": driver_same.group(0)}

    qty = QTY_RE.search(text)
    if qty:
        fields["quantity"] = {"value": int(re.sub(r"[.,\u00a0 ]", "", qty.group(1))), "source_quote": qty.group(0)}
    delivery = DELIVERY_RE.search(text)
    if delivery:
        fields["delivery"] = {"value": delivery.group(0), "source_quote": delivery.group(0)}
    install = INSTALL_RE.search(text)
    if install:
        fields["installation"] = {"value": install.group(0), "source_quote": install.group(0)}
    fields.update(scope_fields(text))

    option = OPTION_RE.search(text)
    return {
        "language": detect_language(text),
        "fields": fields,
        "selected_option": option.group(1).upper() if option else None,
        "method": "rules",
        "warnings": [],
    }


def _validate_llm(data: dict, text: str, baseline: dict) -> tuple[dict, list[str]]:
    fields = _empty_fields()
    warnings: list[str] = []
    raw = data.get("fields") or {}
    for key in TECH_FIELDS + EXTRA_FIELDS + SCOPE_FIELDS:
        item = raw.get(key) or {}
        value, quote = item.get("value"), item.get("source_quote")
        if value in (None, "", "null"):
            continue
        if not quote_in_text(quote, text):
            warnings.append(f"{key}: 模型给出的原文片段在买家消息中找不到，已丢弃")
            continue
        try:
            if key == "power_w":
                value = int(float(str(value).replace(",", ".")))
                if str(value) not in quote:
                    raise ValueError
            elif key == "ip_rating":
                match = re.search(r"(\d{2})", str(value))
                value = f"IP{match.group(1)}"
                if match.group(1) not in quote:
                    raise ValueError
            elif key == "driver":
                value = str(value).upper()
            elif key == "quantity":
                value = int(re.sub(r"[^\d]", "", str(value)))
        except (ValueError, AttributeError):
            warnings.append(f"{key}: 数值与原文片段不一致，已丢弃")
            continue
        entry = {"value": value, "source_quote": quote}
        if key in SCOPE_FIELDS:
            # The model may identify a novel value, but cannot assert support or clear a review.
            entry["status"] = "changed"
        if key in TECH_FIELDS:
            status = item.get("status", "changed")
            allowed = ("changed", "unchanged", "tentative") if key == "driver" else ("changed", "unchanged")
            base_key = {"power_w": "rated_power_w", "ip_rating": "protection_rating", "driver": "driver_model"}[key]
            if status not in allowed:
                status = "changed"
            if status == "changed" and value == baseline[base_key]:
                status = "unchanged"
            entry["status"] = status
        fields[key] = entry
    return fields, warnings


def extract(text: str, baseline: dict) -> dict:
    rules = rule_extract(text, baseline)
    user = json.dumps({
        "current_configuration": {
            "model": baseline["model"], "rated_power_w": baseline["rated_power_w"],
            "protection_rating": baseline["protection_rating"], "driver": baseline["driver_model"],
        },
        "buyer_message": text,
    }, ensure_ascii=False)
    data = llm.chat_json(SYSTEM_PROMPT, user)
    if not data:
        return rules

    fields, warnings = _validate_llm(data, text, baseline)
    for key in TECH_FIELDS + EXTRA_FIELDS + SCOPE_FIELDS:
        if fields[key]["value"] is None and rules["fields"][key]["value"] is not None:
            fields[key] = rules["fields"][key]
    for key in SCOPE_FIELDS:
        if rules["fields"][key]["value"] is not None:
            fields[key] = rules["fields"][key]
    option = data.get("selected_option")
    option = option.upper() if isinstance(option, str) and option.upper() in ("A", "B", "C") else None
    language = data.get("language") if data.get("language") in ("de", "en", "zh") else rules["language"]
    return {
        "language": language,
        "fields": fields,
        "selected_option": option or rules["selected_option"],
        "method": "llm+rules",
        "warnings": warnings,
    }


INSTR_OPTION_RE = re.compile(r"(?:方案|option|variante)\s*([ABC])", re.I)
INSTR_HIDE_DATE_RE = re.compile(r"不要?(?:承诺|写|给|提).{0,8}(?:交期|日期|交货)|隐藏.{0,4}交期|先不(?:承诺|写)交期|no (?:fixed )?(?:delivery )?date", re.I)
INSTR_SHOW_DATE_RE = re.compile(r"(?:恢复|显示|写上|加上).{0,4}交期", re.I)
INSTR_ONLY_DE_RE = re.compile(r"只(?:要|保留|给|出)?德语|仅德语|only german", re.I)
INSTR_ONLY_EN_RE = re.compile(r"只(?:要|保留|给|出)?英语|仅英语|only english", re.I)
INSTR_BOTH_RE = re.compile(r"英德|中英德|两种语言|都要", re.I)
INSTR_EMAIL_RE = re.compile(r"邮件(?:风格|格式|版)", re.I)
INSTR_RFQ_RE = re.compile(r"国际站|RFQ", re.I)

INSTR_PROMPT = """把外贸业务员对回复草稿的修改指令映射成 JSON：
{"select_option": "A|B|C|null", "hide_delivery_date": true/false/null, "languages": ["en","de"] 或 null, "channel": "email|alibaba_rfq|null"}
只映射明确提到的内容，没提到的填 null。"""


def parse_instruction(text: str) -> dict:
    result = {"select_option": None, "hide_delivery_date": None, "languages": None, "channel": None}
    if m := INSTR_OPTION_RE.search(text):
        result["select_option"] = m.group(1).upper()
    if INSTR_HIDE_DATE_RE.search(text):
        result["hide_delivery_date"] = True
    elif INSTR_SHOW_DATE_RE.search(text):
        result["hide_delivery_date"] = False
    if INSTR_ONLY_DE_RE.search(text):
        result["languages"] = ["de"]
    elif INSTR_ONLY_EN_RE.search(text):
        result["languages"] = ["en"]
    elif INSTR_BOTH_RE.search(text):
        result["languages"] = ["en", "de"]
    if INSTR_EMAIL_RE.search(text):
        result["channel"] = "email"
    elif INSTR_RFQ_RE.search(text):
        result["channel"] = "alibaba_rfq"

    if all(v is None for v in result.values()):
        data = llm.chat_json(INSTR_PROMPT, text) or {}
        if str(data.get("select_option", "")).upper() in ("A", "B", "C"):
            result["select_option"] = data["select_option"].upper()
        if isinstance(data.get("hide_delivery_date"), bool):
            result["hide_delivery_date"] = data["hide_delivery_date"]
        if isinstance(data.get("languages"), list):
            langs = [x for x in data["languages"] if x in ("en", "de")]
            result["languages"] = langs or None
        if data.get("channel") in ("email", "alibaba_rfq"):
            result["channel"] = data["channel"]
    return result

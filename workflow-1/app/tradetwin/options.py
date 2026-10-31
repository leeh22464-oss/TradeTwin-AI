"""工作流一的报价方案：规划候选配置 → 交给工作流二算补测代价 → 叠加单价与交期（合成演示口径）。"""

from .knowledge import KnowledgeBase


def plan(request: dict, env: dict) -> dict[str, tuple[str, dict]]:
    """request: {power_w, ip_rating, driver, driver_status}；env 为工作流二的 envelope。
    返回 {option_id: (kind, config)}。"""
    cov = env["coverage"]
    base_driver = env["product"]["driver"]
    requested = {"power_w": request["power_w"], "ip_rating": request["ip_rating"],
                 "driver": request["driver"] or base_driver}
    plans = {"A": ("requested", requested)}

    if request.get("driver_status", "unchanged") in ("tentative", "unknown") and requested["driver"] == base_driver:
        plans["B"] = ("new_driver", {**requested, "driver": "DRV-NEW"})

    lo, hi = cov["power_range_w"]["min"], cov["power_range_w"]["max"]
    if not lo <= requested["power_w"] <= hi:
        clamped = {**requested, "power_w": hi if requested["power_w"] > hi else lo}
        plans[chr(ord("A") + len(plans))] = ("within_coverage", clamped)
    return plans


def unit_price(config: dict, quantity: int, retest_cost: float | None, baseline: dict, kb: KnowledgeBase) -> float | None:
    if retest_cost is None:
        return None
    p = kb.commercial["pricing"]
    price = p["base_unit_price_eur"] + (config["power_w"] - p["base_power_w"]) * p["per_watt_eur"]
    if config["ip_rating"] != baseline["ip_rating"]:
        price += p["ip44_surcharge_eur"]
    if config["driver"] != baseline["driver"]:
        price += p["new_driver_surcharge_eur"]
    price += retest_cost / max(quantity, 1)
    return round(price, 2)


def build_option(option_id: str, kind: str, wf2: dict, quantity: int, baseline: dict, kb: KnowledgeBase) -> dict:
    config = wf2["config"]
    return {
        "option_id": option_id,
        "kind": kind,
        "config": dict(config),
        "quantity": quantity,
        "coverage": wf2,
        "retest_items": wf2["retest_items"],
        "estimated_cost_eur": wf2["estimated_cost_eur"],
        "estimated_days": wf2["estimated_days"],
        "days_breakdown": wf2["days_breakdown"],
        "unit_price_eur": unit_price(config, quantity, wf2["estimated_cost_eur"], baseline, kb),
        "lead_time_working_days": (kb.commercial["pricing"]["base_lead_working_days"] + wf2["estimated_days"]
                                   if wf2["estimated_days"] is not None else None),
        "assumption": _assumption(kind, config, baseline),
        "assumption_version": wf2["assumption_version"],
        "source_type": wf2["source_type"],
        "synthetic": wf2["synthetic"],
        "human_confirmed": wf2["human_confirmed"],
    }


def mark_fastest(options: list[dict]) -> list[dict]:
    priced = [o for o in options if o.get("estimated_days") is not None and o.get("estimated_cost_eur") is not None]
    if priced:
        fastest = min(priced, key=lambda o: (o["estimated_days"], o["estimated_cost_eur"]))
        for option in options:
            option["fastest"] = option is fastest and len(priced) > 1
    return options


def _assumption(kind: str, config: dict, baseline: dict) -> str:
    base_driver = baseline["driver"]
    if kind == "requested":
        driver = "保持 " + base_driver if config["driver"] == base_driver else "使用 " + config["driver"]
        return f"按买家要求 {config['power_w']}W / {config['ip_rating']}，{driver}"
    if kind == "new_driver":
        return f"{config['power_w']}W / {config['ip_rating']}，更换新驱动电源"
    return f"调整为 {config['power_w']}W / {config['ip_rating']}，落在现有报告功率覆盖区间内"

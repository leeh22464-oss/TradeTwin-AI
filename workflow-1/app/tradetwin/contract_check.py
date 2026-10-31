"""工作流二联调自检：python -m tradetwin.contract_check [--url http://host:port/path | --module pkg.mod]

契约不符 → 退出码 1；结论或费用与参考实现不同 → 只提示，不算失败（规则以工作流二为准）。"""

import argparse
import json
import os
import sys

CASES = {
    "A": {"power_w": 36, "ip_rating": "IP44", "driver": "DRV-A"},
    "B": {"power_w": 36, "ip_rating": "IP44", "driver": "DRV-NEW"},
    "C": {"power_w": 30, "ip_rating": "IP44", "driver": "DRV-A"},
    "D": {"power_w": 28, "ip_rating": "IP20", "driver": "DRV-A"},
    "E": {"power_w": 36, "ip_rating": None, "driver": None},
}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--url")
    parser.add_argument("--module")
    args = parser.parse_args()
    if args.url:
        os.environ.update(WORKFLOW2_MODE="http", WORKFLOW2_URL=args.url)
    elif args.module:
        os.environ.update(WORKFLOW2_MODE="python", WORKFLOW2_MODULE=args.module)

    from . import coverage, workflow2
    from .knowledge import get_kb

    print(f"工作流二：{workflow2.provider_name()}  契约：{workflow2.CONTRACT_VERSION}")
    try:
        env = workflow2.envelope()
        print("✔ envelope 符合契约：", json.dumps(env["coverage"], ensure_ascii=False)[:160])
        got = workflow2.evaluate(CASES)
    except workflow2.Workflow2Error as exc:
        print("✘", exc)
        return 1
    print(f"✔ evaluate 符合契约，规则版本 {got['rule_version']}")
    for w in got["warnings"]:
        print("  ⚠", w)

    kb = get_kb()
    ref = coverage.contract_evaluate({"configs": [{"config_id": k, **v} for k, v in CASES.items()]}, kb)
    ref_by_id = {r["config_id"]: r for r in ref["results"]}
    diffs = 0
    for cid, cfg in CASES.items():
        mine = got["results"][cid]
        theirs = ref_by_id[cid]
        status = {f["item_key"]: f["status"] for f in mine["findings"]}
        expected = {f["item_key"]: f["status"] for f in theirs["findings"]}
        line = (f"  {cid} {cfg}: 补测 {mine['retest_items']} €{mine['estimated_cost_eur']} +{mine['estimated_days']}天"
                f" · 文件 {mine['document_updates']}")
        print(line)
        if status != expected or mine["estimated_cost_eur"] != theirs["estimated_cost_eur"] \
                or mine["estimated_days"] != theirs["estimated_days"]:
            diffs += 1
            print(f"    ↳ 与参考实现不同：参考 {expected} €{theirs['estimated_cost_eur']} +{theirs['estimated_days']}天")
    print("完成。" + (f"{diffs} 个用例与参考实现结论不同，请确认是规则差异而不是 bug。" if diffs else "与参考实现一致。"))
    return 0


if __name__ == "__main__":
    sys.exit(main())

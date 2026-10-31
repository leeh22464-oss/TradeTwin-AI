# 工作流一 ↔ 工作流二 接口契约 `tradetwin.wf2.v1`

对应架构图中的 “03 / 取代价：调用工作流二的补测结果”。

| 层 | 负责 | 代码 |
|---|---|---|
| L1 输入、L2 变更单 | 工作流一 | `extract.py`、`pipeline.py`、`mailbox.py`、插件 |
| L3 证据、L4 覆盖推理与最小补测、L5 补测费用和周期 | **工作流二** | 队友实现；`coverage.py` 只是参考实现和契约样例 |
| L5 报价方案（A/B/C 候选配置、单价、交期）、L6 回复与校验 | 工作流一 | `options.py`、`writer.py`、`checker.py` |

工作流一只通过 `workflow2.py` 调用工作流二，不读取工作流二的内部表。工作流二可以随意改规则、数据结构和解析方式，只要输入输出符合下面的契约。

## 接入方式（`app/.env`）

```ini
WORKFLOW2_MODE=local                  # 默认：用 coverage.py 参考实现
WORKFLOW2_MODE=python                 # 同一仓库内的 Python 模块
WORKFLOW2_MODULE=workflow2_team.api   #   需提供 envelope() -> dict 和 evaluate(request: dict) -> dict
WORKFLOW2_MODE=http                   # 独立服务（任何语言）
WORKFLOW2_URL=http://127.0.0.1:9000   #   需提供 GET /envelope 和 POST /evaluate
```

接入后先跑联调自检：

```powershell
cd app
python -m tradetwin.contract_check --module workflow2_team.api
python -m tradetwin.contract_check --url http://127.0.0.1:9000
```

本服务的 `GET /api/workflow2/envelope` 和 `POST /api/workflow2/evaluate` 返回参考实现的结果，可以直接对照。

## 1. envelope：现有证据的覆盖范围

工作流一用它规划替代方案（例如把 36W 降到覆盖上限 30W）。结果会缓存 60 秒。

```json
{
  "contract_version": "tradetwin.wf2.v1",
  "rule_version": "KB-0.2.0/COST-DEMO-V0.1",
  "product": {"model": "NL-L24", "power_w": 24, "ip_rating": "IP20", "driver": "DRV-A"},
  "coverage": {
    "report_id": "TR-DEMO-NL-L24-01",
    "power_range_w": {"min": 18, "max": 30},
    "ip_rating": "IP20",
    "driver": "DRV-A",
    "evidence": [{"document_id": "DOC-CONFLICT-TEST-001", "page": 2, "quote": "覆盖功率区间：18–30W"}]
  }
}
```

必填项：`contract_version`、`product`、`coverage.power_range_w.min/max`、`coverage.ip_rating`、`coverage.driver`。

## 2. evaluate：批量评估候选配置

请求（工作流一 → 工作流二）。一次请求最多带 A/B/C 三个候选配置；值为 `null` 表示买家尚未确认。

```json
{
  "contract_version": "tradetwin.wf2.v1",
  "request_id": "WF1-3f2a9c01de",
  "scope": {"market": "EU", "product_scope": "indoor_fixed_led_luminaire"},
  "configs": [
    {"config_id": "A", "power_w": 36, "ip_rating": "IP44", "driver": "DRV-A"},
    {"config_id": "C", "power_w": 30, "ip_rating": "IP44", "driver": "DRV-A"}
  ]
}
```

响应（工作流二 → 工作流一），每个 `config_id` 一条：

```json
{
  "contract_version": "tradetwin.wf2.v1",
  "rule_version": "KB-0.2.0/COST-DEMO-V0.1",
  "request_id": "WF1-3f2a9c01de",
  "results": [{
    "config_id": "A",
    "findings": [{
      "item_key": "thermal_rise",
      "item": "温升与耐热相关测试",
      "status": "NEEDS_RETEST",
      "reason": "36W 超出报告覆盖区间 18–30W",
      "evidence": [{"document_id": "DOC-CONFLICT-TEST-001", "page": 2, "quote": "覆盖功率区间：18–30W"}],
      "rule_refs": ["RULE-COVERAGE-RANGE-001"]
    }],
    "retest_items": [{
      "test_key": "thermal_rise",
      "name": {"zh": "温升与耐热相关测试", "en": "temperature rise and heat resistance tests", "de": "Erwärmungs- und Wärmebeständigkeitsprüfungen"},
      "cost_eur": 1200,
      "lab_days": 6
    }],
    "document_updates": ["DoC", "label", "German instructions"],
    "estimated_cost_eur": 2100,
    "estimated_days": 8,
    "days_breakdown": {"new_driver_sample": 0, "lab_parallel": 6, "document_update": 2},
    "manual_review_required": true,
    "owner_actions": [{"owner_role": "QUALITY_COMPLIANCE", "action": "确认密封件材料证据"}],
    "issues": [],
    "synthetic": true,
    "human_confirmed": false,
    "source_type": "synthetic_demo_mapping",
    "assumption_version": "COST-DEMO-V0.1"
  }]
}
```

| 字段 | 必填 | 说明 |
|---|---|---|
| `findings[].status` | 是 | `COVERED` / `NEEDS_RETEST` / `DOCUMENT_UPDATE` / `MANUAL_REVIEW` / `NOT_ENOUGH_EVIDENCE`；未知值按 `MANUAL_REVIEW` 处理 |
| `findings[].evidence` | 是 | 每条要有 `document_id`、`page`、`quote`。**`COVERED` 没有证据会被降为 `MANUAL_REVIEW`** |
| `retest_items[]` | 是 | `test_key`、`cost_eur`、`lab_days` 必填；`name.en` / `name.de` 用于写买家回复，缺省时回复里写成“additional test (key)” |
| `estimated_cost_eur` / `estimated_days` | 是 | 该配置的补测总费用和总增加天数（工作流二决定串行还是并行） |
| `synthetic` / `human_confirmed` | 是 | 必须明确声明；演示数据为 `true` / `false` |
| `document_updates` | 否 | 建议使用 `DoC`、`label`、`German instructions`，其他名称原样写进回复 |
| `owner_actions` | 否 | 合并进内部待办；`owner_role` 取 `SALES` / `ENGINEERING` / `QUALITY_COMPLIANCE` / `LAB_PURCHASING` |
| `issues` | 否 | 跨文件一致性问题（结构同知识库 `findings`），只在内部界面显示，不进买家回复 |

约定的特殊情况：

- 驱动电源不变时，EMC 结论应为 `MANUAL_REVIEW`（可能沿用、需确认）。工作流一据此在回复里写“预计可沿用，待工程确认”。
- 参数为 `null` 时，对应项返回 `NOT_ENOUGH_EVIDENCE`，费用可以为 0。

## 失败时工作流一怎么做

调用超时、报错、`contract_version` 不对、缺少必填字段时，工作流一**不会用本地数据冒充**：

- 本轮状态为 `NEEDS_MANUAL_REVIEW`，模式为 `pending_check`。
- 给买家只发“品质团队正在核对证据，稍后给方案”的过渡回复，以及缺失参数的追问，不出现价格和天数。
- 内部待办增加“人工核对证据覆盖后再报价”。
- 这次结果不写入幂等缓存，工作流二恢复后同一封邮件可以重新计算。

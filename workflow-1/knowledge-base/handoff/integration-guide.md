# 接入指南

本指南面向负责把知识库接入 AI 应用、规则引擎或演示工作流的队友。包本身不实现 OCR、向量库或模型调用；它定义输入、证据、规则、覆盖判断和报价选项契约。所有费用、周期和参数—测试映射均为合成演示数据。

## 推荐导入顺序

1. `manifest.json`：读取 `market`、`product_scope`、版本和数据状态。
2. `public-rules/source-index.json`：建立 `source_id → 官方 URL/范围/核验日期` 索引。
3. `public-rules/rule-cards.jsonl` 与 `checklist.json`：建立 `rule_id/check_id → 触发条件、字段、风险边界`。
4. `synthetic-data/canonical-product.json`：读取主数据和变更事件。
5. `synthetic-data/packs/**`：按 `pack_id` 导入文件，保留 `document_id`、页码和原文；优先加载 coverage、mapping、cost 文件。
6. `glossary/zh-en-de-terms.json`：做字段归一和中英德回复适配。
7. `collaboration/`：把发现转换成可交接问题卡，链路为品质/合规 → 工程 → 采购/实验室 → 业务。
8. `test-cases/`：运行回归检查并记录实际 TP/FN、覆盖分类和页码定位结果。

## 检索键

优先使用结构化过滤：`market=EU`、`product_scope=indoor_fixed_led_luminaire`、`source_id`、`rule_id`、`check_id`、`pack_id`、`document_id`、`owner_role`、`coverage_status`、`test_item`、`option_id`。检索到规则卡后，再返回其来源 URL、适用边界、`decision_limit` 和 `human_review`。`source_type=synthetic_demo_mapping` 时必须显示合成标记。

## 文件解析和页码证据

解析器先识别每个文件的 `document_id`，再按 `第 N 页` 分段。字段提取结果建议保存：

```json
{
  "document_id": "DOC-CONFLICT-DOC-001",
  "page": 1,
  "field": "rated_power",
  "value": "24W",
  "quote": "额定功率：24W",
  "confidence": 0.99,
  "synthetic": true
}
```

没有文件、页码、原文或低置信度时，不得生成带确定口吻的硬伤结论；应转为 `MANUAL_REVIEW` 并说明缺口。

## 变更覆盖与最小补测

先读取报告覆盖区间、覆盖 IP、驱动电源和测试项目，再比较客户新配置：

- 命中区间：可输出 `COVERED`，仍保留人工边界。
- 超出功率区间或 IP 变更：输出 `NEEDS_RETEST` 和最小补测候选。
- 驱动电源未变：最多输出 `MANUAL_REVIEW` 的“可能沿用”假设，不自动跳过 EMC/电气复核。
- 型号、功率、防护等级或语言变化：输出 `DOCUMENT_UPDATE`，列出 DoC、标签、说明书等更新项。
- 覆盖范围缺失或报告不可读：输出 `NOT_ENOUGH_EVIDENCE`，不得生成确定报价。

## 跨文件核验

先比较规范化字段，再返回双方证据，不要静默覆盖旧值。推荐核验顺序：型号/SKU → 额定功率 → 输入电压 → 版本/日期 → 测试样品 → 标签/说明书语言。对生态设计等规则，先确认对象是完整灯具、光源还是控制装置，再决定是否触发。

## 结构化结果示例

```json
{
  "run_id": "RUN-DEMO-001",
  "scope": {"market": "EU", "product_scope": "indoor_fixed_led_luminaire"},
  "status": "NEEDS_MANUAL_REVIEW",
  "assumptions": ["参数—测试映射 v0.1 为合成演示", "费用和周期待采购/实验室确认"],
  "coverage_findings": [{"item":"温升与耐热相关测试","status":"NEEDS_RETEST","reason":"36W 超出报告覆盖区间 18–30W","evidence":[{"document_id":"DOC-CONFLICT-TEST-001","page":2,"quote":"覆盖功率区间：18–30W"}],"rule_refs":["RULE-COVERAGE-RANGE-001"]}],
  "document_updates": ["DoC", "label", "German instructions"],
  "quote_options": [{"option_id":"A","estimated_cost_eur":2100,"estimated_days":8,"synthetic":true,"human_confirmed":false},{"option_id":"B","estimated_cost_eur":3600,"estimated_days":12,"synthetic":true,"human_confirmed":false}],
  "findings": [
    {
      "finding_id": "FIND-CONFLICT-001",
      "severity": "HARD_ISSUE_CANDIDATE",
      "finding": "规格书为 NL-L36/36W，声明为 NL-L24/24W。",
      "evidence": [
        {"document_id":"DOC-CONFLICT-SPEC-001","page":1,"quote":"型号 / SKU：NL-L36；额定功率：36W"},
        {"document_id":"DOC-CONFLICT-DOC-001","page":1,"quote":"声明对象型号：NL-L24；额定功率：24W"}
      ],
      "rule_refs": ["RULE-DOC-IDENTITY-001", "RULE-RATED-POWER-001"],
      "owner_role": "ENGINEERING",
      "next_action": "确认实际出货配置和声明覆盖关系。",
      "confidence": 0.99,
      "manual_review_reason": "跨文件冲突需要工程和品质负责人确认。"
    }
  ]
}
```

硬伤候选必须有证据；结果不得写“已认证”“一定无法清关”或“法规已确认”。`NO_ISSUE_FOUND_IN_SCOPE` 只表示当前检查项没有发现问题。费用和周期必须同时出现假设、来源类型和 `synthetic: true`。

## 第二轮对话

首轮返回全量报告。用户可以要求“改用方案 A”“只保留硬伤”“生成德语追问”“按业务岗位列待办”，应用只能改变筛选、排序或表达，不能删除源证据、覆盖主数据、改变规则版本或把未解决项改成通过。若用户要求隐藏风险，应解释仍需保留在内部报告中。

## 异常处理

- 文件不存在：返回缺件清单和 `MANUAL_REVIEW`。
- 文件不可读：返回文件状态和重新上传/人工核验动作。
- 字段缺失：返回缺失字段，不用空值参与“通过”判定。
- 文件冲突：并列展示双方页码和原文，创建问题卡。
- 解析置信度低：降低结论确定性，要求复核。
- 模型或规则服务不可用：使用本地已核验快照；无快照时明确不可用，不猜答案。
- 未知市场/产品：拒绝套用 EU LED 检查表，要求选择已配置范围。
- 报价服务不可用：保留 `NOT_ENOUGH_EVIDENCE` 或 `MANUAL_REVIEW`，只返回补件/追问，不伪造实验室价格。

## 最小演示命令

```powershell
& .\tests\check-knowledge-base.ps1
```

推荐演示顺序：基准包 → 冲突包 → 问题卡交接 → 第二轮输出调整 → 测试集统计。合成结果只用于验证流程和结构。

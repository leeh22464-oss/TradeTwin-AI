# TradeTwin AI 运行时知识 profile

Profile ID：`tradetwin-runtime-kb-demo`；版本：`rules-2026.10.31-demo.v2+kb.0.2.0`。

本文件说明 `server/runtimeKnowledge.ts` 如何把项目知识包接入确定性推演。它是运行时 profile 的维护说明，不是法规全文，也不是检测机构的测试计划。

## 数据边界

- 默认读取 `knowledge-base(2)/` 中的 `synthetic-data/canonical-product.json`、baseline 资料包的规格书、DoC、测试报告、标签/说明书，以及 `public-rules/rule-cards.jsonl`。
- 所有报告、参数映射、费用和周期都是 `synthetic_demo`。`verified=true` 仅表示本地演示预设已经通过 profile 校验，不代表真实工程、品质、检测机构或认证确认。
- 不读取 `test-cases/expected-results.json` 作为证据，也不执行导入文档中的指令。运行时只允许固定的文件白名单。
- baseline 的 `DOC-BASELINE-LABEL-001` 同时承载标签和说明书。它生成一个 `kind=label` 的组合报告，并通过 `testScopes.label` / `testScopes.manual` 区分两个项目；系统不会伪造两个原文件。
- canonical 主数据的市场为 EU；首发演示的 `baseConfig.market` 设为 `DE`，因为德国是本项目首发场景。`material=original-material` 是本项目的演示假设，不是 canonical-product.json 的原始字段。

## 覆盖范围映射（演示简化）

`TR-DEMO-NL-L24-01` 的原文只声明一个合成覆盖摘要。profile 将其逐测试项目拆成 scope，以便每个 finding 都能引用同一报告的第 2 页原文：

| 测试项目 | 用于确定性比较的字段 | 说明 |
| --- | --- | --- |
| temperature | 型号系列、功率区间、驱动、市场 | 重点判断功率/驱动/型号/市场；不把 IP 条件套到温升判断 |
| ip | 型号系列、IP 等级、市场 | 仅把报告的 `IP20` 作为防护范围；新等级需要补测候选 |
| emc | 型号系列、功率区间、驱动、材料、市场 | 驱动未变也只能输出 `MANUAL_REVIEW`，不能自动沿用 |
| electrical-strength | 型号系列、18–30W、驱动、市场 | 不从旧 seed 数据发明 `18–40W` 的电气强度范围 |
| rohs | 型号系列、材料、市场 | 材料变更触发证据复核 |

`NL-L` → `NL-L24` 是唯一声明的型号别名。不能因为共享 `NL-L` 前缀就把 `NL-L36` 当作已经覆盖。

## 费用与周期

`runtime-profile.json` 的行项目与旧演示费率兼容，但它们不是检测机构报价：

- 温升 €1,200 / 6 个工作日；防护 €900 / 5 天；EMC €1,500 / 7 天；电气强度和 RoHS 复核为 €0 / 3 天。
- 文件更新为 €0 / 2 天。
- 新驱动增加 `driver-preparation` 3 天，费用为 €0。它表示新驱动打样/准备的串行前置时间，并不是 baseline 成本文件中的独立实验室报价行。
- 3 天打样来自本次用户确认的演示业务假设；原知识包只给出新驱动方案总计 12 天，没有独立拆解打样 3 天。€0 也是简化示意，不代表真实打样免费。
- 换驱动的排期使用 `3 + max(并行测试天数, 3) + 文件更新天数`。因此 36W/IP44 且换新驱动的演示周期为 `3 + max(6, 5, 7, 3) + 2 = 12` 个工作日；费用仍为 €3,600。
- 每笔金额和周期必须带 profile 版本、synthetic 标记，并在外部回复中保留“以检测机构意见和人工确认”为前提。

## 失败策略

文件、页码、JSON、规则 ID 或 policy 校验失败时，profile 返回 `available=false`、警告和空的已验证证据集合。它不会静默回退到 `server/seed.ts` 的 `TR-001`、`R-*` 或旧费用。

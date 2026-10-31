# TradeTwin 工作台 A 方案验收

状态：**本轮 finishing review Pass**。3 项 UI review 修复均 resolved、remaining clear，disposition 为 **ship**；该结论仅适用于本轮 review 范围，不代表整个产品生产发布或完整 WCAG 通过。

日期：2026-10-31  
范围：React 19 / TypeScript / Vite 前端的“案件队列 + 专注详情”工作台；费用、周期、报告、案件和企业资料均为合成示意数据。

## 1. 验收目标与实现范围

### 入口：案件队列

- 应用默认进入案件队列，使用 [CaseQueue.tsx](../src/components/CaseQueue.tsx) 和 [queueUtils.ts](../src/queueUtils.ts) 的真实案件记录。
- 搜索支持客户、案件、型号和买家原话；空格分词按 AND 匹配。
- “未推演 / 含人工核验 / 含补测 / 已有回复”四类条件可组合。
- 排序支持更新时间最新/最早、客户 A–Z、费用从低到高/从高到低；未知费用始终末尾，真实 €0 不被当成未知。
- 每页 10/20；可切换可选列、舒适/紧凑密度。案件与入口列始终保留。
- 桌面显示白纸表格；`≤1024px` 隐藏窄表格和列显示，转为带案件身份、状态、参数变更、费用/交期、更新时间和入口的摘要列表。

### 单案：专注详情

- 从队列进入后复用既有单案推演工作区：配置对照、证据、合规账单、方案 A/B、客户对话和英德回复共享同一案件上下文。
- 返回案件队列会保留队列搜索/筛选状态；忙碌或读取中时入口受保护。
- 详情分段导航提供“配置 / 证据 / 账单 / 报价方案”锚点；导航固定在 `top:71px`，账单摘要固定在 `top:112px`，`≤1100px` 账单摘要和商业条变为两列，商业条标题与货值总计跨列。
- 证据行可打开 portal 抽屉，展示规则 ID、状态、报告编号、页码、原文/来源链接、合成数据标识和人工覆盖理由；原结论不被静默删除。

### 响应式与交互状态

- `≤860px` 侧栏变为带 Menu/X 的固定抽屉，抽屉独立滚动；Escape 关闭，Tab/Shift+Tab 循环焦点，主内容在打开时 `inert`。
- 请求配置、数量或单价被编辑后显示“未保存”。点击“返回案件队列”或切换案件会打开自定义放弃确认；刷新或“新建询盘”会提示先保存；对话、选择方案和生成报价前才会自动保存。
- 保存失败时保留用户输入、显示错误并停止后续动作；未保存弹层支持继续编辑、放弃修改、Escape、初始焦点与焦点循环。
- 主要阅读文字按当前 CSS 实际为 14px，常用辅助信息为 12px；部分 metadata、时间和状态上下文保留 11px/10px。
- 视觉系统沿用 [DESIGN.md](../DESIGN.md) 和 [.impeccable/design.json](../.impeccable/design.json) 中已有的墨绿、纸面、语义状态、圆角和阴影 token；本轮未引入 Tailwind 或 shadcn/ui，图标使用 Lucide。

## 2. 真实验证记录

### 自动检查

- 最近一次业务/队列测试 `npm test`：**67/67 通过**（engine 41、API 15、model 5、queue 6）。最后 CSS/Menu finishing 分支没有重新跑这组测试，不把它写成 CSS 修改后的新测试结果。
- 最新 `npm run build`：**通过**；TypeScript、Vite 前端和 esbuild 服务端构建均通过。
- 隔离 QA 实例使用 3002：smoke 实际完成 **€2,100 / 8 天 → 方案 A 后 €900 / 7 天 → 暂不承诺具体交期**，保存 5 条消息、5 条审计事件。运行记录为 `test-results/smoke.json`。
- 队列浏览器运行记录为 `test-results/queue-browser.json`；这些 `test-results` 文件属于忽略的运行证据，不是提交产物。

### 浏览器实际操作

已实际检查：

1. 队列 16 案分页为 10+6；追加隔离 smoke 与 UI 新建合成案后最终 18 案；主项目 3001 原 3 案未被本轮 QA 修改。
2. 搜索、组合筛选、空状态清除、更新时间/客户/费用排序、未知费用末尾、真实零费用排序、列隐藏/恢复和舒适/紧凑密度。
3. 未保存状态的返回/切换自定义放弃确认、刷新/新建先保存提示、Escape/focus 行为；对话/方案/报价自动保存成功后方案 A 重算与返回队列同步；保存失败保留输入且不继续后续动作。
4. 证据抽屉原文、报告页码、键盘关闭/焦点恢复；手机导航 Menu/X、独立滚动、Escape、焦点循环、`inert`。
5. 最终 1440、1060、900、768、399、390 六个宽度均无页面横向溢出；1060/900/768/399/390 的 DOM 复核确认 `asideBelow=true`、`barInside=true`、每个子项 `childrenInside=true`，`scrollWidth` 等于视口宽度。

`queue-browser.json` 中初次 `detail` 的 900px/912px 是修复前历史记录；修复后的 `longNames` 900px 与 `queue-final` 900px 均为 900px，其他最终宽度也与视口一致。最终 DOM 与运行记录写入 `test-results/queue-final-review.json`。运行截图位于被忽略的 `.impeccable/review/queue-a`，本验收文档不生成对被忽略截图的强制相对链接。

最终 CSS 复核确认：`≤1180px` 工作区上下排列；`≤1100px` 商业条为两列、标题与总计跨列、账单摘要两列；`≤860px` aside 两列；`≤630px` aside 一列。`detail-900.png` 证明完整订单/货值/账单/对话无内部重叠；`mobile-nav-bottom.png` 证明手机导航滚动后 footer 可达（`scrollHeight=793`、`clientHeight=658`、`scrollTop=134.5`、footer `596–644`），并确认 Escape、`main inert` 恢复和焦点循环。

## 3. 独立 review 项

首轮 finish review verdict 为 **fix**，指出三项。随后由独立 Luna finishing reviewer 复核（专用 reviewer 不可用），最终 verdict 为 **Pass**，3 项均 resolved、remaining clear，disposition 为 **ship**（仅本轮三项 UI 修复范围）：

| review 项 | 当前实现记录 | 最终 verdict |
|---|---|---|
| 900px 表格过窄 | 已改为 `≤1024px` 摘要列表，仅桌面保留比较表和列显示；证据 `user-900.png`（CSS 424–444）。 | **resolved / Pass** |
| 900px 详情内部重叠/溢出风险 | 已按最终 CSS 在 `≤1180px` 将工作区上下排列、在 `≤1100px` 将商业条改为两列并让标题/总计跨列；`detail-900.png` 证明完整内容无重叠（对应 CSS 264、504–510）。 | **resolved / Pass** |
| 手机导航 X 与滚动 | 已改为 Menu/X、独立侧栏滚动并保留 Escape、焦点循环与 `main inert`；`mobile-nav-bottom.png` 证明 footer 可达（对应 App 346、CSS 511–514）。 | **resolved / Pass** |

本结论不覆盖真实模型、生产鉴权、性能指标、完整 WCAG 或整个产品的生产发布。

## 4. 设计与检测边界

- detector 只运行过一次，且在最终集成前：1 项既有 Inter 通用 warning、115 项 design-token advisory（54 color、52 size、9 radius）。本轮没有重复运行，也不把 advisory 当作构建/运行失败。
- 旧 [界面审查](界面审查.md) 是此前单案界面审查历史，不作为本轮 A 方案结论。
- 未验证真实外部模型、真实检测机构数据/费率/排期、生产鉴权、多租户或性能指标；本地演示与回退模式会明确标识。
- 未宣称完整 WCAG 或生产视觉 QA；本轮仅记录实际操作过的键盘、焦点、inert 和六个宽度行为。
- 扫描 PDF 无 OCR；空文本、未知参数、范围不明和规则未命中继续进入人工核验，不会被界面包装为合规放行。
- 98% 是原框架验收目标，不是本项目测得的召回率。

对应使用路径见 [README](../README.md) 与 [三分钟演示](演示说明.md)，完整验证流水见 [验证记录](验证记录.md)。

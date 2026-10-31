# 贸链通 TradeTwin · 变更询盘工作台

买家要求改参数（功率、防护等级、驱动电源）时，系统读取询盘，判断现有检测报告哪些还能沿用、哪些需要补测，把补测代价算进报价方案，生成可审核的英 / 德回复，并在发送前做风险校验。

两个入口共用同一个后端：

- **邮箱接入**：展会客户、独立站、老客户的邮件询盘。IMAP 只读拉取，回复存入草稿箱，**不自动发送**。
- **浏览器插件**：阿里巴巴国际站的 IM / RFQ 对话。读取买家消息，把回复填进输入框，**不点击发送**。

## 运行

```powershell
cd app
.\run.ps1          # 或：pip install -r requirements.txt; python -m uvicorn tradetwin.server:app --port 8000
```

打开 http://127.0.0.1:8000 。不填任何配置也能完整演示：使用规则模板和 `tradetwin/samples` 里的离线邮件。

测试：`python -m pytest -q`

## 配置（可选）

复制 `.env.example` 为 `.env`：

- **模型**：填写任意 OpenAI 兼容接口。模型只做抽取和润色；润色结果没有通过数字和措辞校验时，自动回退到模板。
- **邮箱**：在邮箱设置里开启 IMAP，生成授权码，填入 `MAIL_PASSWORD`。163 / 126 邮箱会自动发送 IMAP ID 命令。

## 插件（仓库根目录 `extension/`）

1. Chrome / Edge 打开 `chrome://extensions`，开启开发者模式。
2. 选择“加载已解压的扩展程序”，选中 `TradeTwin AI/extension` 目录。
3. 在 alibaba.com 的买家对话里点击插件图标，打开侧边栏。
4. 选中买家消息，点“读取选中的买家消息”，再点“分析并生成回复”。
5. 先在页面的回复输入框里点一下，再点“填入回复框”；找不到输入框时会自动复制到剪贴板。
6. 也可以自己在输入框里写一版，再点“我写 AI 审”。

换了一个买家时点“新会话”。插件只读取你选中的内容，从不点击发送。

## 与工作流二合并

工作流一只通过 `tradetwin/workflow2.py` 调用工作流二（证据覆盖、最小补测、补测费用周期）。契约、接入方式和失败处理见 [docs/workflow2-contract.md](docs/workflow2-contract.md)。队友接入后运行 `python -m tradetwin.contract_check --module 模块名` 或 `--url 服务地址` 做联调自检。

## 架构

```
邮件(IMAP) / 插件 / 手动粘贴
        │
   extract.py   模型抽取 + 正则兜底；每个值必须带原文出处（source_quote）
        │
  pipeline.py   多轮会话合并、幂等缓存、状态判定
        │
  options.py    规划候选配置 A / B / C
        │
 workflow2.py ──→ 工作流二（队友）：覆盖结论 + 页码证据 + 补测费用周期
        │          本地参考实现 coverage.py
  options.py    叠加单价与交期
        │
   writer.py    英 / 德模板（可选模型润色）
  checker.py    数字一致性、约束、无依据承诺、渠道规则 → 红 / 黄 / 绿
        │
 mailbox.py 草稿箱  /  插件填入输入框   —— 人工审核后由业务员发送
```

## 数据与第三方声明

- 产品、报告、买家、费用、周期全部是比赛现场构造的**合成演示数据**（`knowledge-base/`、`tradetwin/data/commercial.json`、`tradetwin/samples/`），不代表任何真实企业或检测结论。
- 第三方依赖：FastAPI、Uvicorn、httpx、pytest。模型通过用户自行配置的 OpenAI 兼容接口调用。
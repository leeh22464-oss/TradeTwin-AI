# 工作流一：变更理解与报价选项

外贸业务侧：读买家询盘 → 抽出变更单 → 调用工作流二取代价 → 生成英/德回复并校验。

通过根目录 Node 工作台统一使用；补测费用与证据来自工作流二，按同一 `session_id` 共享案件。

| 子目录 | 内容 |
|---|---|
| `app/` | FastAPI 工作台：IMAP 只读收件、邮箱草稿、手动输入、回复校验 |
| `extension/` | Chrome / Edge 插件，在 alibaba.com 读取选中文字、填入回复框 |
| `demo-reports/` | 给证据库导入的模拟温升补充报告 TR-004 |
| `knowledge-base/` | 工作流一运行所需的合成知识库 |

## 运行

```powershell
# 在仓库根目录安装 Python requirements 后
npm run dev
```

打开 [统一工作台](http://127.0.0.1:5173)。不配邮箱、不配模型也能使用离线样例和规则模板；工作流二 Node 服务仍须运行。安装与生产启动见 [根 README](../README.md)。

插件：Chrome / Edge → `chrome://extensions` → 开发者模式 → 加载已解压的扩展程序 → 选本目录下的 `extension/`。

工作流二契约见 [接口契约](app/docs/workflow2-contract.md)，联调与限制见 [双工作流联调](../docs/工作流联调.md)。邮箱只写草稿，插件只填回复框，发送始终由用户在原应用完成。

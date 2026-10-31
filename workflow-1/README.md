# 工作流一（暂存，尚未并入主工程）

外贸业务侧：读买家询盘 → 抽出变更单 → 调用工作流二取代价 → 生成英/德回复并校验。  
本目录暂时独立存放，不改仓库根目录的 Node 工作台。

| 子目录 | 内容 |
|---|---|
| `app/` | FastAPI 工作台：邮箱 IMAP/SMTP、手动输入、回复校验 |
| `extension/` | Chrome / Edge 插件，在 alibaba.com 读取选中文字、填入回复框 |
| `demo-reports/` | 给证据库导入的模拟温升补充报告 TR-004 |
| `knowledge-base/` | 工作流一运行所需的合成知识库 |

## 运行

```powershell
cd workflow-1/app
.\run.ps1
```

打开 http://127.0.0.1:8000 。不配邮箱、不配模型也能用离线样例演示。

插件：Chrome / Edge → `chrome://extensions` → 开发者模式 → 加载已解压的扩展程序 → 选本目录下的 `extension/`。

和主工程工作流二对接的契约见 `app/docs/workflow2-contract.md`。

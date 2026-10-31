# 第三方组件与资料

本项目直接依赖及许可如下；确切版本和传递依赖以 `package-lock.json` 与相应 npm 包的 LICENSE 为准。

| 组件 | 用途 | 许可 |
|---|---|---|
| React / React DOM | 工作台界面 | MIT |
| TypeScript | 类型检查 | Apache-2.0 |
| Vite / @vitejs/plugin-react | 开发与前端构建 | MIT |
| Express | HTTP API | MIT |
| Node.js / 内置 SQLite | 运行时与本地持久化 | Node.js MIT；SQLite Public Domain |
| multer | 文件上传 | MIT |
| pdf-parse 2.4.5 | PDF 文字提取 | Apache-2.0；底层 PDF.js Apache-2.0 |
| dotenv | 读取项目环境配置 | BSD-2-Clause |
| zod | 输入/模型结构校验 | MIT |
| lucide-react | 界面图标 | ISC |
| Vitest | 自动测试 | MIT |
| tsx / esbuild / concurrently | TypeScript 运行、构建及开发进程 | MIT |
| Python | 工作流一运行时 | PSF License |
| FastAPI / Starlette | 工作流一 API | MIT / BSD-3-Clause |
| Uvicorn | 本机 ASGI 服务 | BSD-3-Clause |
| httpx | 工作流二及模型 HTTP 调用 | BSD-3-Clause |
| pytest | Python 回归验证 | MIT |

Python 直接依赖见 `workflow-1/app/requirements.txt`；安装版本与传递依赖以本机环境和对应包 LICENSE 为准。Chrome / Edge 插件使用浏览器扩展 API，无打包的第三方页面脚本。

未内置第三方商业检测报告或企业生产数据。演示报告与知识内容为本项目合成材料，实际报告上传与授权由使用者负责。法规、平台和赛事资料保留各来源链接及适用范围，不因引用而获得认证背书。

前端设计使用已安装的 Impeccable skill（Apache-2.0）辅助工作流程，技能本身不作为前端运行依赖打包。官方活动手册来自项目 `docs/黑客松/` 所记录的飞书来源。

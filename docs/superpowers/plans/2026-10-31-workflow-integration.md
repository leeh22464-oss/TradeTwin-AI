# 双工作流兼容整合 Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement task-by-task. User already authorized implementation; execute inline with bounded delegated tasks required by AGENTS.md.

**Goal:** 以用户 Python 工作流一替换主线重复销售功能，接入队友运行中的工作流二。

**Architecture:** Node 保留品质引擎与共享案件存储，Python 保留销售流程；同源代理和版本契约连接，单一代价来源。

**Tech Stack:** React/TypeScript/Express/SQLite + FastAPI/Python/httpx。

**Spec:** ../specs/2026-10-31-workflow-integration.md

## Global Constraints

- 不推送远端；保留原目录；合成数据明确标识。
- 模型不决定补测、金额、周期；未知费用不可伪装零费用。
- 证据须有文档、正整数页码、原文和规则版本。

## Task 1: 工作流二契约

Files: server/workflow2.ts, tests/workflow2.test.ts, server/index.ts（主 agent 注册路由）。

- [ ] 先写真实 engine/SQLite 的契约测试：36W/IP44=2100/8、30W/IP44=900/7、缺失报告/参数费用为空、无效请求、证据版本变化。
- [ ] 实现 registerWorkflow2(app, db)，GET /api/workflow2/envelope 和 POST /api/workflow2/evaluate；从 db 读取证据和费率，保留测试独立范围，不生成销售方案。
- [ ] 运行 vitest 并交接。

## Task 2: 工作流一稳健性

Files: workflow-1/app/tradetwin/{pipeline,workflow2,options}.py, workflow-1/app/tradetwin/data/commercial.json, workflow-1/app/tests/test_integration.py。

- [ ] 失败测试验证第二轮旧缓存失效、选择方案同时显式参数优先、未知费用不进入报价、响应 request_id 对应、严格页码/数值。
- [ ] 补齐缺失合成商业配置，默认通过 HTTP 调用主线工作流二；可单独启用 reference。
- [ ] 证据版本纳入缓存键；失败不缓存；保留双语追问。
- [ ] pytest 验证。

## Task 3: 单一入口与共享案件

Files: server/workflow1.ts, scripts/workflows.mjs, package.json, vite.config.ts, tests/workflow1.test.ts。

- [ ] 写代理失败、返回同步、同 session 更新不新建、证据原文路由测试。
- [ ] 同源代理销售静态页/API；结果同步为同 session 的案件，保存完整工作流一输出用于追溯。
- [ ] 根 dev/start 管理 Python 子进程退出和环境；Python 不可用时返回可恢复错误。

## Task 4: 页面与交付

Files: src/App.tsx, src/components/SalesWorkspace.tsx, src/styles.css, README.md, docs/工作流联调.md。

- [ ] 移除 React 重复销售交互，替换为工作流一入口；品质核验、证据、知识库保持可用。
- [ ] 列出工作流职责、字段与方案映射、异常、安装运行和两轮演示步骤。
- [ ] npm test、npm run build、pytest、真实双进程 HTTP 冒烟与浏览器检查，记录实际结果。

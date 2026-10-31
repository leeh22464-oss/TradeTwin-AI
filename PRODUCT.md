# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

delegated: 用户授权自主决定。React + TypeScript + Vite，Express / Node 24，SQLite 持久化，本地知识库，服务端 OpenAI 兼容模型适配器。

## Users

外贸业务员在回复德国买家的配置变更前核算代价；品质/合规核验报告与补测；采购跟进物料与供应商证据。

## Product Purpose

把产品变更的合规代价提前算入报价。理解 → 核验 → 推演 → 多语言回复 → 第二轮修正，两个工作流共享配置与证据。

## Positioning

按具体测试项目判断现有证据覆盖，确定性生成最小补测、费用、周期和替代配置，再回写商务报价。

## Operating Context

首版欧盟室内固定式 LED 灯具，桌面浏览器为主，手机可查看和修改。工作空间需要核对配置、风险、报告页码与英德回复，不需要装饰性介绍页。

## Capabilities and Constraints

完整要求见 docs/BUILD_PROMPT.md。缺失或不确定证据进入人工核验；模型不决定合规与费率；合成数据明确标注；交期等待实验室确认。模型凭据尚未配置，需如实区分演示、真实调用与失败回退。用户已授权自主推进，不再为技术或视觉常规选择增加确认流程。

## Brand Commitments

贸链通 TradeTwin AI。“答应客户之前，先算清合规账单。”中文工作界面，英语/德语业务产出。

## Evidence on Hand

docs/项目框架/ 中的 PDF 与创新说明；docs/黑客松/ 中的官方手册和赛题。报告、报价和企业案例为合成演示材料，没有生产实测指标。

## Product Principles

- 证据先于结论，缺失先核验。
- 一次变更贯穿补测与报价。
- 规则可复现、来源可追溯。
- 工作界面直接呈现任务与下一步。

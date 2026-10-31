import 'dotenv/config';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { extname, join, resolve } from 'node:path';
import express, { type ErrorRequestHandler, type Request, type RequestHandler, type Response } from 'express';
import multer from 'multer';
import type {
  AnalysisResult,
  AuditEvent,
  CaseRecord,
  Channel,
  ChatMessage,
  Coverage,
  EvidenceReport,
  Finding,
  KnowledgeEntry,
  ProductConfig,
} from '../shared/types.js';
import { BASE_CONFIG, RULE_VERSION, createSeedCase, seedCosts, seedKnowledge, seedReports, seedRules } from './seed.js';
import { analyzeChange } from './engine.js';
import { AppDatabase, createdAt, type DatabaseOptions } from './db.js';
import { ConfigValidationError, extractChange, generateQuote, getModelStatus, normalizeConfig, testModel } from './model.js';
import { searchKnowledge, syncKnowledgePackage, type KnowledgePackageBundle } from './knowledge.js';
import { researchKnowledge, ResearchInputError } from './research.js';
import { getOfficialConfig, type FetchLike } from './openai.js';
import { loadRuntimeKnowledge, type RuntimeKnowledgeProfile } from './runtimeKnowledge.js';
import {
  importMarkdownVault,
  MAX_UPLOAD_BYTES,
  normalizeTestScopes,
  parseUpload,
  validateCoverageConfirmation,
} from './documents.js';

export interface AppOptions extends DatabaseOptions {
  seed?: boolean;
  knowledgePackagePath?: string;
  researchFetch?: FetchLike;
  researchTimeoutMs?: number;
  /** Explicit legacy fixtures for compatibility tests; production uses the knowledge profile. */
  runtimeKnowledge?: RuntimeKnowledgeProfile | false;
  runtimePolicyPath?: string;
}

export class HttpError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, message: string, code = 'BAD_REQUEST') {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function text(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value.trim() : fallback;
}

function optionalText(value: unknown): string | undefined {
  return typeof value === 'string' ? value.trim() : undefined;
}

function numberValue(value: unknown, field: string, options: { min?: number; integer?: boolean } = {}): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new HttpError(400, `${field} 必须是有限数字`);
  if (options.integer && !Number.isInteger(value)) throw new HttpError(400, `${field} 必须是整数`);
  if (options.min !== undefined && value < options.min) throw new HttpError(400, `${field} 不能小于 ${options.min}`);
  return value;
}

function channelValue(value: unknown, fallback: Channel): Channel {
  if (value === undefined) return fallback;
  if (value !== 'email' && value !== 'rfq') throw new HttpError(400, 'channel 必须为 email 或 rfq');
  return value;
}

function hash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function isManagedKnowledgeEntry(entry: KnowledgeEntry): boolean {
  const source = entry.source.toLocaleLowerCase();
  if (source === 'manual' || source.includes('obsidian')) return false;
  if (entry.id.startsWith('kbpack-')) return true;
  return Boolean(entry.metadata?.packagePath) && source.startsWith('public-rules/');
}

function activeKnowledgeEntries(db: AppDatabase, bundle?: KnowledgePackageBundle): KnowledgeEntry[] {
  const currentPackageIds = new Set((bundle?.entries ?? []).map((entry) => entry.id));
  const persisted = db.listKnowledge().filter((entry) => !isManagedKnowledgeEntry(entry) || currentPackageIds.has(entry.id));
  const byId = new Map(persisted.map((entry) => [entry.id, entry]));
  for (const entry of bundle?.entries ?? []) if (!byId.has(entry.id)) byId.set(entry.id, entry);
  return [...byId.values()];
}

function retrieveKnowledge(db: AppDatabase, query: string, limit = 6, bundle?: KnowledgePackageBundle): KnowledgeEntry[] {
  return searchKnowledge(activeKnowledgeEntries(db, bundle), query, limit);
}

function cloneConfig(config: ProductConfig): ProductConfig {
  return { ...config };
}

function routeParam(value: string | string[]): string {
  return Array.isArray(value) ? value[0] ?? '' : value;
}

function seedBundle(runtime: RuntimeKnowledgeProfile | false) {
  const demo = createSeedCase();
  if (runtime && runtime.available) {
    demo.name = `德国客户 · ${runtime.baseConfig.model} 灯具变更`;
    demo.baseConfig = cloneConfig(runtime.baseConfig);
    demo.requestedConfig = { ...runtime.baseConfig, powerW: 36, ip: 'IP44' };
    demo.inquiry = `Buyer requests 36W and IP44 for ${runtime.baseConfig.model}.`;
  }
  return {
    reports: runtime ? runtime.reports : seedReports,
    costs: runtime ? runtime.costs : seedCosts,
    rules: runtime ? runtime.rules : seedRules,
    knowledge: seedKnowledge,
    cases: [demo],
  };
}

function activeReports(db: AppDatabase, runtime: RuntimeKnowledgeProfile | false, conflicts: string[] = []): EvidenceReport[] {
  if (!runtime) return db.listReports();
  if (!runtime.available) return db.listReports().filter((report) => report.source === 'uploaded').map((report) => ({
    ...report, verified: false, status: 'needs_review' as const, notes: `${report.notes} 运行知识不可用，当前仅供查看，不能自动用于报价。`,
  }));
  const currentIds = new Set(runtime.reports.map((report) => report.id));
  return db.listReports().filter((report) => {
    if (report.source === 'uploaded') return true;
    if (report.knowledgeSource) return currentIds.has(report.id);
    const legacy = seedReports.find((item) => item.id === report.id);
    return !legacy || hash(legacy) !== hash(report);
  }).map((report) => conflicts.includes(report.id)
    ? { ...report, verified: false, status: 'needs_review' as const, notes: `${report.notes} 知识源已更新，与人工修改冲突，需重新核对原文。` }
    : report);
}

function audit(caseId: string, type: string, detail: unknown, fingerprint?: string): AuditEvent {
  return {
    id: `audit-${randomUUID()}`,
    caseId,
    type,
    actor: 'server',
    detail: typeof detail === 'string' ? detail : JSON.stringify(detail),
    createdAt: createdAt(),
    ruleVersion: RULE_VERSION,
    ...(fingerprint ? { fingerprint } : {}),
  };
}

function invalidateCasesForEvidence(db: AppDatabase, detail: Record<string, unknown>): void {
  for (const item of db.listCases()) {
    if (!item.analysis && !item.quote) continue;
    item.analysis = null;
    item.quote = null;
    item.updatedAt = createdAt();
    db.saveCase(item);
    db.addAudit(audit(item.id, 'evidence.changed', detail));
  }
}

interface CaseExtractionMeta {
  source: 'inquiry' | 'explicit-config' | 'base-config';
  mode: string;
  modelName: string;
  summary: string;
  retrievalIds: string[];
  warning?: string;
  requiresReview?: boolean;
}

interface CreatedCase {
  item: CaseRecord;
  extraction: CaseExtractionMeta;
}

function boundedText(value: unknown, field: string, max: number, fallback = ''): string {
  if (value === undefined) return fallback;
  if (typeof value !== 'string') throw new HttpError(400, `${field} 必须是字符串`);
  const normalized = value.trim();
  if (normalized.length > max) throw new HttpError(400, `${field} 不能超过 ${max} 字符`);
  return normalized || fallback;
}

async function createCase(db: AppDatabase, body: Record<string, unknown>, knowledgeBundle?: KnowledgePackageBundle, runtime?: RuntimeKnowledgeProfile | false): Promise<CreatedCase> {
  const baseConfig = cloneConfig(runtime ? runtime.baseConfig : BASE_CONFIG);
  const hasExplicitConfig = body.config !== undefined;
  if (hasExplicitConfig && (!body.config || typeof body.config !== 'object' || Array.isArray(body.config))) {
    throw new HttpError(400, 'config 必须是对象');
  }
  const name = boundedText(body.name, 'name', 200, '新询盘案件');
  const buyer = boundedText(body.buyer, 'buyer', 200, '待确认买家');
  const inquiry = boundedText(body.inquiry, 'inquiry', 12_000);
  let commitment = boundedText(body.commitment, 'commitment', 12_000);
  let requestedConfig: ProductConfig;
  let extraction: CaseExtractionMeta;
  if (!hasExplicitConfig && inquiry) {
    const knowledge = retrieveKnowledge(db, `${inquiry} ${baseConfig.market ?? ''}`, 6, knowledgeBundle);
    const extracted = await extractChange(inquiry, baseConfig, null, knowledge);
    requestedConfig = normalizeConfig(extracted.config, baseConfig);
    if (extracted.withholdDelivery) commitment = '暂不承诺具体交期';
    extraction = {
      source: 'inquiry',
      mode: extracted.mode,
      modelName: extracted.modelName,
      summary: extracted.summary,
      retrievalIds: knowledge.map((entry) => entry.id),
      ...(extracted.warning ? { warning: extracted.warning } : {}),
      ...(extracted.requiresReview ? { requiresReview: true } : {}),
    };
  } else {
    requestedConfig = normalizeConfig(body.config as Partial<ProductConfig> | undefined, baseConfig);
    extraction = {
      source: hasExplicitConfig ? 'explicit-config' : 'base-config',
      mode: hasExplicitConfig ? 'explicit-config' : 'none',
      modelName: 'not-run',
      summary: hasExplicitConfig ? '使用请求中提供的显式配置，未从 inquiry 覆盖配置。' : '未提供 inquiry，保留基线配置。',
      retrievalIds: [],
    };
  }
  const created = createdAt();
  const item: CaseRecord = {
    id: `case-${randomUUID()}`,
    name,
    buyer,
    createdAt: created,
    updatedAt: created,
    round: 1,
    baseConfig,
    requestedConfig,
    quantity: numberValue(body.quantity, 'quantity', { min: 1, integer: true }) ?? 100,
    unitPriceEur: numberValue(body.unitPriceEur, 'unitPriceEur', { min: 0 }) ?? 0,
    channel: channelValue(body.channel, 'email'),
    inquiry,
    commitment,
    analysis: null,
    quote: null,
    messages: [],
    ...(extraction.requiresReview ? { extractionReview: extraction.summary } : {}),
  };
  if (inquiry) appendMessage(item, 'user', inquiry, extraction.mode);
  return { item, extraction };
}

function updateCaseFromBody(item: CaseRecord, body: Record<string, unknown>): { changed: boolean; caseRecord: CaseRecord } {
  let changed = false;
  if (body.config !== undefined) {
    if (!body.config || typeof body.config !== 'object' || Array.isArray(body.config)) throw new HttpError(400, 'config 必须是对象');
    item.requestedConfig = normalizeConfig(body.config as Partial<ProductConfig>, item.requestedConfig);
    if (Object.keys(body.config).length > 0) delete item.extractionReview;
    changed = true;
  }
  const quantity = numberValue(body.quantity, 'quantity', { min: 1, integer: true });
  if (quantity !== undefined) { item.quantity = quantity; changed = true; }
  const unitPrice = numberValue(body.unitPriceEur, 'unitPriceEur', { min: 0 });
  if (unitPrice !== undefined) { item.unitPriceEur = unitPrice; changed = true; }
  if (body.channel !== undefined) { item.channel = channelValue(body.channel, item.channel); changed = true; }
  if (body.inquiry !== undefined) { item.inquiry = text(body.inquiry); changed = true; }
  if (body.commitment !== undefined) { item.commitment = text(body.commitment); changed = true; }
  if (changed) {
    item.analysis = null;
    item.quote = null;
    item.updatedAt = createdAt();
  }
  return { changed, caseRecord: item };
}

function ensureCase(db: AppDatabase, id: string): CaseRecord {
  const item = db.getCase(id);
  if (!item) throw new HttpError(404, '案件不存在', 'CASE_NOT_FOUND');
  return item;
}

async function runAnalysis(db: AppDatabase, item: CaseRecord, runtime: RuntimeKnowledgeProfile | false, conflicts: string[] = []): Promise<AnalysisResult> {
  const result = analyzeChange(item.requestedConfig, activeReports(db, runtime, conflicts), {
    baseConfig: item.baseConfig,
    commitment: item.commitment,
    costs: runtime ? runtime.costs : db.listCosts(),
    ...(runtime ? { policy: runtime.policy, knowledgeContext: runtime.context } : {}),
  }) as CaseRecord['analysis'];
  if (!result) throw new HttpError(500, '规则引擎未返回分析结果', 'ENGINE_EMPTY');
  if (runtime && !runtime.available) {
    result.findings.push({ id: 'finding-runtime-unavailable', itemId: 'runtime-unavailable', title: '运行知识不可用', category: 'contract', status: 'review', reason: runtime.warnings.join('；'), ruleIds: ['APP-RUNTIME-001'], evidence: [], feeEur: null, days: null });
    result.reviewCount += 1;
    result.canQuote = false;
    result.leadTimeDays = null;
    result.warnings.push('运行知识未通过校验，不能将历史演示证据或已知小计作为完整报价。');
    result.id = `analysis-${hash({ core: result.id, unavailable: runtime.context.fingerprint })}`;
  }
  if (item.extractionReview) {
    result.findings.push({
      id: 'finding-inquiry-ambiguity', itemId: 'inquiry-ambiguity', title: '询盘参数待确认', category: 'contract', status: 'review',
      reason: `${item.extractionReview} 请核对并保存完整配置后再生成确定报价。`,
      ruleIds: ['RULE-PARAMETER-TEST-MAP-001'], evidence: [], feeEur: null, days: null,
    });
    result.reviewCount += 1;
    result.canQuote = false;
    result.leadTimeDays = null;
    result.warnings.push('询盘参数尚未确认，已知费用不是完整报价，不能自动承诺交期。');
    result.id = `analysis-${hash({ core: result.id, extractionReview: item.extractionReview })}`;
  }
  return { ...result, id: result.id || `analysis-${randomUUID()}`, config: cloneConfig(item.requestedConfig) };
}

function appendMessage(item: CaseRecord, role: ChatMessage['role'], content: string, mode?: string): void {
  item.messages.push({ id: `message-${randomUUID()}`, role, content, createdAt: createdAt(), ...(mode ? { mode } : {}) });
}

function findingSummary(finding: Finding): string {
  const evidence = finding.evidence.map((ref) => `${ref.reportId} p.${ref.page}`).join(', ');
  return `${finding.status}: ${finding.title} — ${finding.reason}${evidence ? ` [${evidence}]` : ''}`;
}

function exportMarkdown(item: CaseRecord, reports: EvidenceReport[]): string {
  const lines: string[] = [
    `# TradeTwin AI 案件报告：${item.name}`,
    '',
    `- 案件 ID：${item.id}`,
    `- 买家：${item.buyer}`,
    `- 轮次：${item.round}`,
    `- 渠道：${item.channel}`,
    `- 数量：${item.quantity}`,
    `- 单价（EUR）：${item.unitPriceEur}`,
    `- 导出时间：${createdAt()}`,
    '',
    '## 产品配置',
    '',
    '| 字段 | 基线 | 客户要求 |',
    '|---|---|---|',
    `| 型号 | ${item.baseConfig.model} | ${item.requestedConfig.model} |`,
    `| 功率 | ${item.baseConfig.powerW ?? '—'} W | ${item.requestedConfig.powerW ?? '—'} W |`,
    `| 防护等级 | ${item.baseConfig.ip ?? '—'} | ${item.requestedConfig.ip ?? '—'} |`,
    `| 驱动 | ${item.baseConfig.driver ?? '—'} | ${item.requestedConfig.driver ?? '—'} |`,
    `| 材料 | ${item.baseConfig.material ?? '—'} | ${item.requestedConfig.material ?? '—'} |`,
    `| 市场 | ${item.baseConfig.market ?? '—'} | ${item.requestedConfig.market ?? '—'} |`,
    '',
    '## 分析结果',
    '',
  ];
  if (!item.analysis) lines.push('尚未执行分析。');
  else {
    lines.push(`- 规则版本：${item.analysis.ruleVersion}`);
    lines.push(`- 估算费用：€${item.analysis.totalCostEur}`);
    lines.push(`- 交期影响：${item.analysis.leadTimeDays == null ? '待人工/实验室确认' : `${item.analysis.leadTimeDays} 个工作日`}`);
    lines.push(`- 可报价：${item.analysis.canQuote ? '是' : '否（存在待核验项）'}`);
    lines.push('', '### Findings', '', '| 状态 | 项目 | 原因 |', '|---|---|---|');
    for (const finding of item.analysis.findings) lines.push(`| ${finding.status} | ${finding.title} | ${finding.reason.replace(/\|/g, '\\|')} |`);
    lines.push('', '### 逐项证据与规则', '');
    for (const finding of item.analysis.findings) {
      lines.push(`#### ${finding.title}`, '', `- 结论：${finding.status}`, `- 规则：${finding.ruleIds.join('、') || '未命中，需人工核验'}`);
      if (!finding.evidence.length) lines.push('- 来源：缺失，需人工核验。');
      for (const ref of finding.evidence) {
        lines.push(`- 来源：${ref.reportId}，第 ${ref.page} 页`, '', ...ref.quote.split('\n').map((line) => `> ${line}`), '');
      }
    }
    lines.push('', '### 方案', '', '| 方案 | 配置 | 费用 | 周期 | 说明 |', '|---|---|---:|---:|---|');
    for (const alternative of item.analysis.alternatives) lines.push(`| ${alternative.id} | ${alternative.config.powerW ?? '—'}W / ${alternative.config.ip ?? '—'} | €${alternative.totalCostEur} | ${alternative.leadTimeDays ?? '待确认'} | ${alternative.summary.replace(/\|/g, '\\|')} |`);
  }
  lines.push('', '## 证据清单', '', '| 报告 | 状态 | 已确认 | 页数 |', '|---|---|---:|---:|');
  for (const report of reports) lines.push(`| ${report.title} (${report.id}) | ${report.status} | ${report.verified ? '是' : '否'} | ${report.pageCount} |`);
  if (item.quote) lines.push('', '## 报价输出', '', '### English', '', item.quote.en, '', '### Deutsch', '', item.quote.de, '', '### 中文岗位待办', '', ...item.quote.internal.sales.map((entry) => `- 业务：${entry}`), ...item.quote.internal.quality.map((entry) => `- 品质：${entry}`), ...item.quote.internal.procurement.map((entry) => `- 采购：${entry}`));
  lines.push('', '## 会话记录', '');
  for (const message of item.messages) lines.push(`- **${message.role}**（${message.createdAt}）：${message.content}`);
  return `${lines.join('\n')}\n`;
}

const asyncRoute = (handler: RequestHandler): RequestHandler => (req, res, next) => {
  Promise.resolve(handler(req, res, next)).catch(next);
};

export function createApp(options: AppOptions = {}): express.Express {
  const db = new AppDatabase(options);
  let runtime: RuntimeKnowledgeProfile | false = options.runtimeKnowledge ?? loadRuntimeKnowledge({ packagePath: options.knowledgePackagePath, policyPath: options.runtimePolicyPath });
  let runtimeConflicts: string[] = [];
  if (options.seed !== false) db.seedIfEmpty(seedBundle(runtime));
  if (runtime) runtimeConflicts = db.syncRuntimeReports(runtime.reports);
  // The package path is configured at process startup (or by the test
  // harness); request bodies never get to choose a filesystem path.
  let knowledgeBundle = syncKnowledgePackage(db, options.knowledgePackagePath);

  const app = express();
  app.locals.db = db;
  app.locals.dataDir = db.dataDir;
  app.locals.knowledgeBundle = knowledgeBundle;
  app.locals.runtimeKnowledge = runtime;
  const refreshRuntime = (): void => {
    if (options.runtimeKnowledge !== undefined) return;
    const next = loadRuntimeKnowledge({ packagePath: options.knowledgePackagePath, policyPath: options.runtimePolicyPath });
    if (runtime && runtime.context.fingerprint === next.context.fingerprint && runtime.available === next.available) return;
    runtime = next;
    runtimeConflicts = db.syncRuntimeReports(next.reports);
    app.locals.runtimeKnowledge = next;
    invalidateRuntimeResults();
  };
  const invalidateRuntimeResults = (): void => {
    if (!runtime) return;
    for (const item of db.listCases()) {
      if (!item.analysis && !item.quote) continue;
      if (runtime.available && item.analysis?.knowledgeContext?.fingerprint === runtime.context.fingerprint) continue;
      const oldVersion = item.analysis?.ruleVersion;
      item.analysis = null;
      item.quote = null;
      item.updatedAt = createdAt();
      db.saveCase(item);
      db.addAudit(audit(item.id, 'knowledge.changed', { oldVersion, version: runtime.context.version, fingerprint: runtime.context.fingerprint, reason: '运行知识或规则更新，清除旧派生结果，保留配置与会话。' }));
    }
  };
  invalidateRuntimeResults();
  app.use(express.json({ limit: '2mb' }));
  app.use(express.urlencoded({ extended: true, limit: '2mb' }));
  app.use('/api', (_req, _res, next) => {
    try { refreshRuntime(); next(); } catch (error) { next(error); }
  });

  const upload = multer({
    storage: multer.memoryStorage(),
    // Modern browsers send UTF-8 multipart filenames. Multer's default is
    // Latin-1 for legacy forms, which turns Chinese names into mojibake.
    defParamCharset: 'utf8',
    limits: { fileSize: MAX_UPLOAD_BYTES },
  });

  app.get('/api/health', (_req, res) => res.json({ ok: true, status: 'ok', time: createdAt(), ruleVersion: RULE_VERSION }));

  app.get('/api/bootstrap', (_req, res) => {
    const bootstrap = db.bootstrap(getModelStatus(), runtime ? runtime.context.version : RULE_VERSION);
    if (runtime) {
      bootstrap.reports = activeReports(db, runtime, runtimeConflicts);
      bootstrap.costs = runtime.costs;
      bootstrap.rules = runtime.rules;
      if (!runtime.available) bootstrap.rules = [...bootstrap.rules, { id: 'APP-RUNTIME-001', title: '运行知识缺失阻断', description: '应用安全规则：运行知识未通过校验时不得自动报价。', category: 'safety', version: runtime.context.version }];
      bootstrap.runtimeKnowledge = { ...runtime.context, available: runtime.available, warnings: [...runtime.warnings, ...runtimeConflicts.map((id) => `${id} 的知识源已更新，人工修改保留并等待复核。`)] };
    }
    res.json(bootstrap);
  });

  app.get('/api/runtime/sources/:index', asyncRoute(async (req, res) => {
    const index = routeParam(req.params.index);
    const source = /^\d+$/.test(index) && runtime ? runtime.context.sources[Number(index)] : undefined;
    if (!source) throw new HttpError(404, '运行知识来源不存在', 'RUNTIME_SOURCE_NOT_FOUND');
    res.type('text/plain').send(await readFile(resolve(source.path), 'utf8'));
  }));

  app.get('/api/cases/:id', (req, res) => res.json(ensureCase(db, routeParam(req.params.id))));

  app.post('/api/cases', asyncRoute(async (req, res) => {
    const created = await createCase(db, asRecord(req.body), knowledgeBundle, runtime);
    const item = created.item;
    db.saveCase(item);
    db.addAudit(audit(item.id, 'case.created', {
      name: item.name,
      buyer: item.buyer,
      extraction: created.extraction,
    }));
    res.status(201).json(item);
  }));

  app.patch('/api/cases/:id', asyncRoute((req, res) => {
    const item = ensureCase(db, routeParam(req.params.id));
    const result = updateCaseFromBody(item, asRecord(req.body));
    if (result.changed) {
      db.saveCase(result.caseRecord);
      db.addAudit(audit(item.id, 'case.updated', { config: item.requestedConfig, commitment: item.commitment }));
    }
    res.json(result.caseRecord);
  }));

  app.post('/api/cases/:id/analyze', asyncRoute(async (req, res) => {
    const item = ensureCase(db, routeParam(req.params.id));
    const body = asRecord(req.body);
    if (body.config !== undefined && (!body.config || typeof body.config !== 'object' || Array.isArray(body.config))) throw new HttpError(400, 'config 必须是对象');
    const config = body.config === undefined ? item.requestedConfig : normalizeConfig(body.config as Partial<ProductConfig>, item.requestedConfig);
    if (body.config && Object.keys(body.config).length > 0) delete item.extractionReview;
    const commitment = body.commitment === undefined ? item.commitment : text(body.commitment);
    const configChanged = hash(item.requestedConfig) !== hash(config);
    const commitmentChanged = item.commitment !== commitment;
    item.requestedConfig = config;
    item.commitment = commitment;
    const analysis = await runAnalysis(db, item, runtime, runtimeConflicts);
    const idempotencyKey = text(body.idempotencyKey) || null;
    // The deterministic analysis ID includes the complete report state
    // (coverage, verification, status, pages and test scopes). Cache only the
    // analysis, never the whole CaseRecord, so newer messages/rounds survive.
    const fingerprint = hash({ endpoint: 'analyze', idempotencyKey, analysisId: analysis.id });
    const cachedValue = db.getCachedRequest(item.id, 'analyze', fingerprint);
    const cached = cachedValue && typeof cachedValue === 'object' && !Array.isArray(cachedValue)
      && 'findings' in cachedValue ? cachedValue as AnalysisResult : null;
    const previousAnalysisId = item.analysis?.id;
    if (cached) {
      item.analysis = cached;
      if (previousAnalysisId !== cached.id) item.quote = null;
      if (configChanged || commitmentChanged || previousAnalysisId !== cached.id) {
        item.updatedAt = createdAt();
        db.saveCase(item);
      }
      return res.json(item);
    }
    item.analysis = analysis;
    item.quote = null;
    item.updatedAt = createdAt();
    db.saveCase(item);
    db.addAudit(audit(item.id, 'analysis.completed', { config, findingCount: analysis.findings.length }, fingerprint));
    db.cacheRequest(item.id, 'analyze', fingerprint, analysis);
    res.json(item);
  }));

  app.post('/api/cases/:id/chat', asyncRoute(async (req, res) => {
    const item = ensureCase(db, routeParam(req.params.id));
    const body = asRecord(req.body);
    const message = text(body.message);
    if (!message) throw new HttpError(400, 'message 不能为空');
    if (message.length > 12_000) throw new HttpError(400, 'message 不能超过 12000 字符');
    const channel = channelValue(body.channel, item.channel);
    const knowledge = retrieveKnowledge(db, `${message} ${item.inquiry} ${item.requestedConfig.market ?? ''}`, 6, knowledgeBundle);
    const extracted = await extractChange(message, item.requestedConfig, item.analysis, knowledge);
    item.requestedConfig = normalizeConfig(extracted.config, item.requestedConfig);
    if (extracted.requiresReview) item.extractionReview = extracted.summary;
    if (extracted.withholdDelivery) item.commitment = '暂不承诺具体交期';
    item.channel = channel;
    item.round += 1;
    appendMessage(item, 'user', message);
    item.analysis = await runAnalysis(db, item, runtime, runtimeConflicts);
    item.updatedAt = createdAt();
    if (item.extractionReview || (runtime && !runtime.available)) {
      item.quote = null;
      appendMessage(item, 'assistant', `${extracted.summary}\n\n${item.extractionReview ? '询盘参数存在歧义，请核对并保存完整配置后再生成报价。' : '运行知识不可用，请先恢复知识源；当前不生成报价。'}`, extracted.mode);
      db.saveCase(item);
      db.addAudit(audit(item.id, 'chat.completed', { summary: extracted.summary, mode: extracted.mode, requiresReview: true, quoteGenerated: false }));
      return res.json(item);
    }
    const quote = await generateQuote(item, channel, knowledge);
    item.quote = quote;
    const warning = extracted.warning ? `\n\n${extracted.warning}` : '';
    appendMessage(item, 'assistant', `${extracted.summary}${warning}\n\n${quote.en}\n\n${quote.de}`, extracted.mode);
    db.saveCase(item);
    db.addAudit(audit(item.id, 'chat.completed', { summary: extracted.summary, mode: extracted.mode, withholdDelivery: extracted.withholdDelivery, retrievalIds: knowledge.map((entry) => entry.id) }));
    res.json(item);
  }));

  app.post('/api/cases/:id/quote', asyncRoute(async (req, res) => {
    const item = ensureCase(db, routeParam(req.params.id));
    const channel = channelValue(asRecord(req.body).channel, item.channel);
    // Always recompute against the current evidence set. Evidence uploads and
    // edits invalidate persisted derived state, while this endpoint also
    // protects callers that hold an older case snapshot.
    item.analysis = await runAnalysis(db, item, runtime, runtimeConflicts);
    item.quote = null;
    if (item.extractionReview || (runtime && !runtime.available)) {
      db.saveCase(item);
      throw new HttpError(409, item.extractionReview ? '询盘参数待确认，请核对并保存完整配置后再生成报价。' : '运行知识不可用，暂不能生成报价。', item.extractionReview ? 'INQUIRY_CONFIRMATION_REQUIRED' : 'RUNTIME_KNOWLEDGE_UNAVAILABLE');
    }
    item.channel = channel;
    const knowledge = retrieveKnowledge(db, `${item.inquiry} ${item.requestedConfig.model} ${item.requestedConfig.market ?? ''}`, 6, knowledgeBundle);
    item.quote = await generateQuote(item, channel, knowledge);
    item.updatedAt = createdAt();
    db.saveCase(item);
    db.addAudit(audit(item.id, 'quote.generated', { channel, mode: item.quote.modelMode, retrievalIds: knowledge.map((entry) => entry.id) }));
    res.json(item);
  }));

  app.post('/api/cases/:id/override', asyncRoute((req, res) => {
    const item = ensureCase(db, routeParam(req.params.id));
    const body = asRecord(req.body);
    const findingId = text(body.findingId);
    const reason = text(body.reason);
    const actor = text(body.actor);
    const decision = body.decision;
    if (!findingId || !reason || !actor) throw new HttpError(400, 'findingId、reason、actor 均不能为空');
    if (decision !== 'accept' && decision !== 'reject') throw new HttpError(400, 'decision 必须为 accept 或 reject');
    const finding = item.analysis?.findings.find((entry) => entry.id === findingId);
    if (!finding) throw new HttpError(404, 'finding 不存在', 'FINDING_NOT_FOUND');
    const event = audit(item.id, 'finding.override', {
      findingId,
      decision,
      actor,
      reason,
      original: finding,
    });
    event.actor = actor;
    db.addAudit(event);
    res.status(201).json(event);
  }));

  app.get('/api/audit', (req, res) => res.json(db.listAudit(optionalText(req.query.caseId))));

  app.post('/api/reports', upload.single('file'), asyncRoute(async (req, res) => {
    if (!req.file) throw new HttpError(400, '请上传 file 文件字段');
    const parsed = await parseUpload({ originalname: req.file.originalname, mimetype: req.file.mimetype, buffer: req.file.buffer });
    const extension = extname(parsed.report.filename).toLocaleLowerCase() || '.bin';
    const storedPath = join(db.uploadsDir, `${parsed.report.id}${extension}`);
    await mkdir(db.uploadsDir, { recursive: true });
    await writeFile(storedPath, req.file.buffer, { flag: 'wx' });
    db.saveReport(parsed.report, storedPath);
    invalidateCasesForEvidence(db, { reportId: parsed.report.id, change: 'added' });
    res.status(201).json(parsed.report);
  }));

  app.patch('/api/reports/:id', asyncRoute((req, res) => {
    const stored = db.getReport(routeParam(req.params.id));
    if (!stored) throw new HttpError(404, '报告不存在', 'REPORT_NOT_FOUND');
    const body = asRecord(req.body);
    const report = { ...stored.report };
    let coverageChanged = false;
    let pagesChanged = false;
    let testScopesChanged = false;
    let verifiedChanged = false;
    const scopeTestsValue = body.scopeTests !== undefined ? body.scopeTests
      : body.selectedTests !== undefined ? body.selectedTests
        : body.testScopeTests !== undefined ? body.testScopeTests
          : body.tests;
    const hasManualScopeInput = body.scopePage !== undefined || scopeTestsValue !== undefined;
    if (body.testScopes !== undefined && hasManualScopeInput) throw new HttpError(400, 'testScopes 不能与 scopePage/勾选项目同时提交');
    if (body.pages !== undefined) {
      if (!Array.isArray(body.pages)) throw new HttpError(400, 'pages 必须是数组');
      const pages = body.pages.map((value, index) => {
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HttpError(400, `pages[${index}] 必须是对象`);
        const page = asRecord(value);
        if (typeof page.page !== 'number' || !Number.isInteger(page.page) || page.page < 1) throw new HttpError(400, `pages[${index}].page 必须是正整数`);
        if (typeof page.text !== 'string') throw new HttpError(400, `pages[${index}].text 必须是字符串`);
        return { page: page.page, text: page.text.slice(0, 200_000) };
      });
      const pageNumbers = new Set(pages.map((page) => page.page));
      if (pageNumbers.size !== pages.length) throw new HttpError(400, 'pages 不能包含重复页码');
      const requestedPageCount = body.pageCount === undefined
        ? Math.max(0, ...pages.map((page) => page.page))
        : numberValue(body.pageCount, 'pageCount', { min: 1, integer: true });
      if (requestedPageCount === undefined || pages.some((page) => page.page > requestedPageCount)) throw new HttpError(400, 'pageCount 小于页码最大值');
      pagesChanged = hash({ pages: stored.report.pages, pageCount: stored.report.pageCount }) !== hash({ pages, pageCount: requestedPageCount });
      report.pages = pages;
      report.pageCount = requestedPageCount;
    } else if (body.pageCount !== undefined) {
      const requestedPageCount = numberValue(body.pageCount, 'pageCount', { min: 1, integer: true });
      if (requestedPageCount === undefined || report.pages.some((page) => page.page > requestedPageCount)) throw new HttpError(400, 'pageCount 小于现有页码');
      pagesChanged = stored.report.pageCount !== requestedPageCount;
      report.pageCount = requestedPageCount;
    }
    if (body.coverage !== undefined) {
      if (!body.coverage || typeof body.coverage !== 'object' || Array.isArray(body.coverage)) throw new HttpError(400, 'coverage 必须是对象');
      coverageChanged = hash(stored.report.coverage) !== hash(body.coverage);
      report.coverage = body.coverage as Coverage;
    }
    if (body.testScopes !== undefined) {
      const normalized = normalizeTestScopes(report, body.testScopes);
      if (normalized.error) throw new HttpError(400, normalized.error);
      report.testScopes = normalized.scopes;
      testScopesChanged = hash(stored.report.testScopes ?? null) !== hash(normalized.scopes ?? null);
    } else if (hasManualScopeInput) {
      if (!Array.isArray(scopeTestsValue) || scopeTestsValue.length === 0 || scopeTestsValue.some((test) => typeof test !== 'string' || !test.trim())) {
        throw new HttpError(400, 'scopePage 必须配合非空的测试项目字符串数组');
      }
      const scopeTests = scopeTestsValue as string[];
      if (new Set(scopeTests).size !== scopeTests.length) throw new HttpError(400, '勾选的测试项目不能重复');
      const scopePage = numberValue(body.scopePage, 'scopePage', { min: 1, integer: true });
      if (scopePage === undefined) throw new HttpError(400, 'scopePage 必须是正整数');
      const proposed: NonNullable<EvidenceReport['testScopes']> = {};
      for (const test of scopeTests) {
        proposed[test] = { coverage: { ...report.coverage, tests: [test] }, page: scopePage };
      }
      const normalized = normalizeTestScopes(report, proposed);
      if (normalized.error) throw new HttpError(400, normalized.error);
      report.testScopes = normalized.scopes;
      testScopesChanged = hash(stored.report.testScopes ?? null) !== hash(normalized.scopes ?? null);
    } else if (report.testScopes) {
      // Re-check existing imported scopes whenever pages/coverage are edited;
      // this also repairs stale quotes by replacing them with the page text.
      const normalized = normalizeTestScopes(report, report.testScopes);
      if (normalized.error) throw new HttpError(400, normalized.error);
      report.testScopes = normalized.scopes;
      testScopesChanged = hash(stored.report.testScopes ?? null) !== hash(normalized.scopes ?? null);
    }
    if (stored.report.verified && (coverageChanged || pagesChanged || testScopesChanged) && body.verified !== true) {
      throw new HttpError(400, '已确认报告的覆盖范围、页码或测试项目范围发生变化，必须使用 verified:true 重新确认');
    }
    if (body.notes !== undefined) report.notes = text(body.notes);
    if (body.verified !== undefined) {
      if (typeof body.verified !== 'boolean') throw new HttpError(400, 'verified 必须是布尔值');
      verifiedChanged = stored.report.verified !== body.verified;
      report.verified = body.verified;
    }
    if (report.verified) {
      const error = validateCoverageConfirmation(report, report.coverage);
      if (error) throw new HttpError(400, `不能确认报告覆盖范围：${error}`);
      report.status = 'ready';
    } else if ((body.verified === false || coverageChanged || pagesChanged || testScopesChanged) && report.status !== 'failed') {
      report.status = 'needs_review';
    }
    db.updateReport(report);
    if (coverageChanged || pagesChanged || testScopesChanged || verifiedChanged) {
      invalidateCasesForEvidence(db, {
        reportId: report.id,
        change: 'updated',
        coverageChanged,
        pagesChanged,
        testScopesChanged,
        verifiedChanged,
      });
    }
    res.json(report);
  }));

  app.get('/api/reports/:id/file', asyncRoute(async (req, res) => {
    const stored = db.getReport(routeParam(req.params.id));
    if (!stored) throw new HttpError(404, '报告不存在', 'REPORT_NOT_FOUND');
    if (stored.sourcePath && existsSync(stored.sourcePath)) {
      const content = await readFile(stored.sourcePath);
      if (stored.report.filename.toLocaleLowerCase().endsWith('.pdf')) res.type('application/pdf').send(content);
      else res.type('text/plain').send(content.toString('utf8'));
      return;
    }
    res.type('text/plain').send(stored.report.pages.map((page) => `--- page ${page.page} ---\n${page.text}`).join('\n'));
  }));

  app.get('/api/knowledge', (req, res) => res.json(db.listKnowledge(optionalText(req.query.q) ?? '')));

  app.get('/api/knowledge/index', (_req, res) => {
    const official = getOfficialConfig();
    const configured = Boolean(official);
    const enabled = configured && knowledgeBundle.status.available && knowledgeBundle.sources.length > 0;
    const message = !configured
      ? '未配置 OPENAI_API_KEY；知识核查仅提供本地命中，不执行联网检索。'
      : !knowledgeBundle.status.available || knowledgeBundle.sources.length === 0
        ? '知识包或官方来源索引不可用，暂不能执行联网核查。'
        : '已配置官方 OpenAI Responses/web_search；联网结果仍需专业人员确认。';
    res.json({
      package: knowledgeBundle.status,
      sources: knowledgeBundle.sources,
      research: {
        configured,
        enabled,
        provider: 'openai',
        model: official?.model || 'gpt-4.1',
        message,
      },
    });
  });

  app.post('/api/knowledge/sync', asyncRoute(async (_req, res) => {
    knowledgeBundle = syncKnowledgePackage(db, options.knowledgePackagePath);
    app.locals.knowledgeBundle = knowledgeBundle;
    res.json(knowledgeBundle);
  }));

  app.post('/api/knowledge/research', asyncRoute(async (req, res) => {
    const body = asRecord(req.body);
    const query = boundedText(body.query, 'query', 2_000);
    if (!query) throw new HttpError(400, 'query 不能为空');
    const sourceIds = body.sourceIds === undefined ? undefined : body.sourceIds;
    if (sourceIds !== undefined && !Array.isArray(sourceIds)) throw new HttpError(400, 'sourceIds 必须是数组');
    let result;
    try {
      result = await researchKnowledge({
        query,
        sourceIds: sourceIds as string[] | undefined,
        bundle: {
          sources: knowledgeBundle.sources,
          // Keep current package entries plus manual/Obsidian entries. Stale
          // managed kbpack rows remain in SQLite for recovery but are not
          // eligible for model/research context.
          entries: activeKnowledgeEntries(db, knowledgeBundle),
        },
        fetchImpl: options.researchFetch,
        timeoutMs: options.researchTimeoutMs,
      });
    } catch (error) {
      if (error instanceof ResearchInputError) throw new HttpError(400, error.message, error.code);
      throw error;
    }
    db.addAudit(audit('knowledge', 'knowledge.researched', {
      query,
      mode: result.mode,
      sourceIds: result.indexedSources.map((source) => source.sourceId),
      citations: result.citations,
      checkedAt: result.checkedAt,
    }));
    res.json(result);
  }));

  app.post('/api/knowledge', asyncRoute((req, res) => {
    const body = asRecord(req.body);
    const title = text(body.title);
    const content = text(body.content);
    if (!title || !content) throw new HttpError(400, 'title 和 content 不能为空');
    const tags = Array.isArray(body.tags) ? body.tags.filter((tag): tag is string => typeof tag === 'string').map((tag) => tag.trim()).filter(Boolean) : [];
    const entry = { id: `knowledge-${randomUUID()}`, title, content, tags, source: 'manual', updatedAt: createdAt() };
    db.saveKnowledge(entry);
    res.status(201).json(entry);
  }));

  app.post('/api/knowledge/import-vault', asyncRoute(async (_req, res) => {
    let imported: Awaited<ReturnType<typeof importMarkdownVault>>;
    try {
      imported = await importMarkdownVault();
    } catch (error) {
      throw new HttpError(400, error instanceof Error ? error.message : '知识库导入失败', 'VAULT_UNAVAILABLE');
    }
    for (const entry of imported.entries) db.saveKnowledge(entry);
    res.json({ imported: imported.entries.length, skipped: imported.skipped, entries: imported.entries });
  }));

  app.get('/api/cases/:id/export', (req, res) => {
    const item = ensureCase(db, routeParam(req.params.id));
    const filename = `${item.id}.md`;
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.type('text/markdown').send(exportMarkdown(item, db.listReports()));
  });

  app.get('/api/model/status', (_req, res) => res.json(getModelStatus()));
  app.post('/api/model/test', asyncRoute(async (_req, res) => res.json(await testModel())));

  const distDir = resolve(process.cwd(), 'dist');
  const distIndex = join(distDir, 'index.html');
  if (existsSync(distIndex)) {
    app.use(express.static(distDir));
    app.use((req, res, next) => {
      if (req.method === 'GET' && !req.path.startsWith('/api')) res.sendFile(distIndex);
      else next();
    });
  }

  const errorHandler: ErrorRequestHandler = (error, _req: Request, res: Response, _next) => {
    if (res.headersSent) return;
    if (error instanceof multer.MulterError) {
      res.status(error.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({ error: error.message, code: error.code });
      return;
    }
    const status = error instanceof HttpError ? error.status : error instanceof ConfigValidationError ? 400 : 500;
    const code = error instanceof HttpError ? error.code : error instanceof ConfigValidationError ? 'INVALID_CONFIG' : 'INTERNAL_ERROR';
    const message = error instanceof Error ? error.message : '服务器处理失败';
    res.status(status).json({ error: message, code });
  };
  app.use(errorHandler);
  return app;
}

export function startServer(): ReturnType<express.Express['listen']> {
  const port = Number.parseInt(process.env.PORT || '3001', 10);
  const host = '127.0.0.1';
  const app = createApp();
  return app.listen(Number.isFinite(port) ? port : 3001, host, () => {
    console.log(`TradeTwin API listening on http://${host}:${Number.isFinite(port) ? port : 3001}`);
  });
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) startServer();


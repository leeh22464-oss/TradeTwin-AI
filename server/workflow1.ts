import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import express, { type Express, type Request, type Response, type NextFunction } from 'express';
import type { CaseRecord, ExtensionCapture, ProductConfig } from '../shared/types.js';
import { AppDatabase } from './db.js';
import { analyzeChange } from './engine.js';
import { BASE_CONFIG, RULE_VERSION } from './seed.js';

const defaultUrl = 'http://127.0.0.1:8000';

function url(): string {
  return (process.env.WORKFLOW1_URL || defaultUrl).replace(/\/$/, '');
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function string(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function preferredOption(result: Record<string, unknown>): Record<string, unknown> {
  const options = [...(result.quote_options as unknown[] ?? []), ...(result.candidate_options as unknown[] ?? [])].map(object);
  return options.find((option) => option.option_id === result.selected_option_id)
    ?? options.find((option) => option.kind === 'requested') ?? {};
}

function requestedConfig(result: Record<string, unknown>, previous = BASE_CONFIG, option = preferredOption(result)): ProductConfig {
  const order = Array.isArray(result.change_order) ? result.change_order.map(object) : [];
  const get = (key: string): unknown => order.find((row) => row.field === key)?.to;
  const config = object(option.config);
  const value = (key: string): unknown => Object.hasOwn(config, key) ? config[key] : get(key);
  const power = value('power_w');
  const extra = (key: string, fallback: string | null): string | null => {
    const supplied = value(key);
    return supplied === undefined ? fallback : typeof supplied === 'string' ? supplied : null;
  };
  return {
    ...previous,
    powerW: typeof power === 'number' && Number.isFinite(power) ? power : null,
    ip: typeof value('ip_rating') === 'string' ? String(value('ip_rating')).toUpperCase() : null,
    driver: typeof value('driver') === 'string' ? String(value('driver')) : null,
    material: extra('material', previous.material), market: extra('market', previous.market),
    model: extra('model', previous.model) ?? previous.model,
  };
}

function parseWorkflow1Result(value: unknown): Record<string, unknown> {
  const result = object(value);
  const require = (ok: unknown, message: string): void => { if (!ok) throw new Error(message); };
  const nonempty = (value: unknown): boolean => typeof value === 'string' && !!value.trim();
  const number = (value: unknown, min = 0): boolean => typeof value === 'number' && Number.isFinite(value) && value >= min;
  require(nonempty(result.session_id) && nonempty(result.run_id), '缺少会话或运行编号');
  require(number(result.round, 1) && Number.isInteger(result.round), 'round 必须是正整数');
  require(typeof result.created_at === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(result.created_at) && Number.isFinite(Date.parse(result.created_at)), 'created_at 必须是有效时间戳');
  require(result.channel === 'email' || result.channel === 'alibaba_rfq', '渠道无效');
  require(Array.isArray(result.change_order), '缺少结构化变更单');
  require(Array.isArray(result.quote_options), 'quote_options 必须是数组');
  require(result.candidate_options === undefined || Array.isArray(result.candidate_options), 'candidate_options 必须是数组');
  const workflow2 = object(result.workflow2), scope = object(result.scope);
  require(typeof workflow2.ok === 'boolean', '缺少品质核验状态');
  require(scope.market === 'EU' && scope.product_scope === 'indoor_fixed_led_luminaire', '产品/市场范围不支持');
  for (const key of ['rule_version', 'evidence_version']) {
    require((scope[key] ?? null) === (workflow2[key] ?? null), `品质核验与范围的 ${key} 不一致`);
  }
  const validateConfig = (raw: unknown): void => {
    const config = object(raw);
    require(Object.keys(config).length > 0, '方案缺少配置');
    require(config.power_w === null || number(config.power_w, Number.MIN_VALUE), '方案功率无效');
    require(config.ip_rating === null || (typeof config.ip_rating === 'string' && /^IP\d{2}$/i.test(config.ip_rating)), '方案 IP 无效');
    require(config.driver === null || nonempty(config.driver), '方案驱动无效');
    for (const key of ['material', 'market', 'model']) if (Object.hasOwn(config, key)) require(config[key] === null || nonempty(config[key]), `方案 ${key} 无效`);
  };
  for (const raw of result.change_order as unknown[]) {
    const row = object(raw);
    require(nonempty(row.field) && Object.hasOwn(row, 'to'), '变更单字段无效');
    if (row.field === 'quantity' && row.to !== null) require(number(row.to, 1) && Number.isInteger(row.to), '数量必须为正整数');
    if (row.field === 'power_w' && row.to !== null) require(number(row.to, Number.MIN_VALUE), '变更功率无效');
    if (row.field === 'ip_rating' && row.to !== null) require(typeof row.to === 'string' && /^IP\d{2}$/i.test(row.to), '变更 IP 无效');
    if (['driver', 'market', 'material'].includes(String(row.field)) && row.to !== null) require(nonempty(row.to), '变更参数无效');
  }
  const all = new Map<string, Record<string, unknown>>();
  for (const key of ['quote_options', 'candidate_options']) {
    const ids = new Set<string>();
    for (const raw of (result[key] as unknown[] | undefined) ?? []) {
      const option = object(raw), id = string(option.option_id);
      require(nonempty(id) && !ids.has(id), '方案编号缺失或重复'); ids.add(id);
      require(['requested', 'new_driver', 'within_coverage'].includes(String(option.kind)), '方案类别无效');
      validateConfig(option.config);
      const prior = all.get(id);
      require(!prior || canonical(prior.config) === canonical(option.config), '候选方案与报价配置不一致');
      all.set(id, option);
      if (key === 'quote_options') {
        require(workflow2.ok === true, '品质核验失败时不得附报价');
        require(nonempty(scope.rule_version) && nonempty(scope.evidence_version), '报价缺少规则或证据版本');
        for (const field of ['unit_price_eur', 'estimated_cost_eur', 'estimated_days', 'lead_time_working_days']) require(number(option[field]), `报价 ${field} 必须是非负有限数字`);
        require(number(option.quantity, 1) && Number.isInteger(option.quantity), '报价数量必须是正整数');
        require(Array.isArray(option.retest_items), '报价缺少补测清单');
        for (const field of ['new_driver_sample', 'lab_parallel', 'document_update']) require(number(object(option.days_breakdown)[field]), '报价排期拆分无效');
        for (const rawTest of option.retest_items as unknown[]) {
          if (typeof rawTest === 'string') continue;
          const test = object(rawTest);
          require(nonempty(test.test_key) && number(test.cost_eur) && number(test.lab_days), '补测费用/周期无效');
        }
      }
    }
  }
  require(result.selected_option_id === null || result.selected_option_id === undefined || (nonempty(result.selected_option_id) && all.has(String(result.selected_option_id))), '选择了不存在的方案');
  return result;
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value as Record<string, unknown>).sort().map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`;
}

function currentEvidenceVersion(db: AppDatabase): string {
  return createHash('sha256').update(canonical({ reports: db.listReports(), costs: db.listCosts() })).digest('hex');
}

function quotePendingReason(result: Record<string, unknown>, config: ProductConfig, db: AppDatabase): string {
  const options = result.quote_options as unknown[];
  if (!options.length || result.mode === 'pending_check' || result.mode === 'incomplete') return '等待证据或参数确认后重新计算';
  if (object(result.scope).evidence_version !== currentEvidenceVersion(db)) return '证据或费率已变化，请重新核验并计算报价';
  if (object(result.scope).rule_version !== `${RULE_VERSION}/COST-DEMO-V0.1`) return '规则版本已变化，请重新核验并计算报价';
  if (config.material !== BASE_CONFIG.material || config.market !== BASE_CONFIG.market || config.model !== BASE_CONFIG.model) return '材料、市场或型号超出当前报价范围，等待人工确认';
  for (const option of options.map(object)) {
    const analysis = analyzeChange(requestedConfig(result, config, option), db.listReports(), { costs: db.listCosts(), includeAlternatives: false });
    const tests = (option.retest_items as unknown[]).map((test) => mapFindingId(typeof test === 'string' ? test : object(test).test_key));
    const breakdown = object(option.days_breakdown);
    if (!analysis.canQuote || analysis.totalCostEur !== option.estimated_cost_eur || analysis.leadTimeDays !== option.estimated_days
      || canonical([...tests].sort()) !== canonical([...analysis.requiredTests].sort())
      || breakdown.new_driver_sample !== 0 || breakdown.lab_parallel !== analysis.calculation.parallelDays || breakdown.document_update !== analysis.calculation.documentationDays) return '补测费用或排期与当前证据不一致，请重新计算';
    for (const raw of option.retest_items as unknown[]) {
      if (typeof raw === 'string') continue;
      const test = object(raw), cost = db.listCosts().find((cost) => cost.id === mapFindingId(test.test_key));
      if (!cost || test.cost_eur !== cost.feeEur || test.lab_days !== cost.days) return '补测单项费率已变化，请重新计算';
    }
  }
  return '';
}

/** Demote stale readiness without rewriting the immutable buyer-round snapshot. */
export function refreshWorkflow1Readiness(item: CaseRecord, db: AppDatabase): CaseRecord {
  if (!item.workflow1QuoteReady || !item.workflow1Result) return item;
  const result = item.workflow1Result;
  const scope = object(result.scope);
  let reason = '';
  if (scope.evidence_version !== currentEvidenceVersion(db) || scope.rule_version !== `${RULE_VERSION}/COST-DEMO-V0.1`) reason = '证据、费率或规则已变化，请重新核验并计算报价';
  else if (canonical(item.requestedConfig) !== canonical(requestedConfig(result, item.baseConfig))) reason = '品质配置已修改，请应用到业务工作台后重新计算';
  else {
    const quantity = (result.change_order as unknown[]).map(object).find((row) => row.field === 'quantity')?.to ?? preferredOption(result).quantity;
    if ((typeof quantity === 'number' && item.quantity !== quantity) || item.channel !== (result.channel === 'alibaba_rfq' ? 'rfq' : 'email')) reason = '数量或报价渠道已修改，请重新计算报价';
  }
  if (reason) {
    item.workflow1QuoteReady = false; item.workflow1PendingReason = reason; item.unitPriceEur = 0; item.quote = null;
    db.saveCase(item);
  }
  return item;
}

type Workflow1SyncOutcome = { status: number; body: Record<string, unknown> };

function syncWorkflow1Result(db: AppDatabase, raw: unknown): Workflow1SyncOutcome {
  let result: Record<string, unknown>;
  try { result = parseWorkflow1Result(raw); } catch (error) {
    return { status: 400, body: { code: 'INVALID_WORKFLOW1_RESULT', message: error instanceof Error ? error.message : '工作流一结果无效' } };
  }
  const sessionId = string(result.session_id).trim(), runId = string(result.run_id).trim();
  const fingerprint = createHash('sha256').update(`${sessionId}:${runId}`).digest('hex');
  let item = db.getCase(sessionId);
  if (item && (db.getCachedRequest(sessionId, 'workflow1.sync', fingerprint) || item.workflow1LastRunId === runId)) {
    refreshWorkflow1Readiness(item, db);
    return { status: 200, body: { case: item, replay: true } };
  }
  const previousRound = typeof item?.workflow1Result?.round === 'number' ? item.workflow1Result.round : 0;
  if (item && Number(result.round) <= previousRound) {
    return { status: 409, body: { code: 'WORKFLOW1_ROUND_CONFLICT', message: '该轮次早于或等于已保存轮次，请载入当前会话后重新计算。' } };
  }
  const createdAt = string(result.created_at);
  const changed = requestedConfig(result, item?.requestedConfig ?? BASE_CONFIG);
  if (!item) {
    item = {
      id: sessionId, name: `工作流一询盘 ${sessionId}`, buyer: '待确认买家', createdAt, updatedAt: createdAt,
      round: 0, baseConfig: { ...BASE_CONFIG }, requestedConfig: changed, quantity: 100, unitPriceEur: 0,
      channel: result.channel === 'alibaba_rfq' ? 'rfq' : 'email', inquiry: string(object(result.input).text),
      commitment: '', analysis: null, quote: null, messages: [],
    };
  }
  item.requestedConfig = changed;
  item.channel = result.channel === 'alibaba_rfq' ? 'rfq' : 'email';
  item.inquiry = string(object(result.input).text, item.inquiry);
  item.round = Number(result.round);
  const options = (result.quote_options as unknown[]).map(object);
  const selected = preferredOption(result);
  const order = (result.change_order as unknown[]).map(object);
  const quantity = order.find((row) => row.field === 'quantity')?.to ?? selected.quantity;
  if (typeof quantity === 'number') item.quantity = quantity;
  const buyer = string(result.buyer_name, string(object(result.input).buyer_name));
  const subject = string(result.subject, string(object(result.input).subject));
  if (buyer.trim()) item.buyer = buyer.trim();
  if (subject.trim()) item.name = subject.trim();
  const deliveryHold = object(result.constraints).hide_delivery_date;
  if (deliveryHold === true) item.commitment = '暂不承诺具体交期';
  else if (deliveryHold === false && item.commitment === '暂不承诺具体交期') item.commitment = '';
  const pendingReason = quotePendingReason(result, changed, db);
  item.workflow1QuoteReady = !pendingReason;
  item.workflow1PendingReason = pendingReason;
  item.workflow1EvidenceVersion = string(object(result.scope).evidence_version);
  item.unitPriceEur = item.workflow1QuoteReady && typeof selected.unit_price_eur === 'number' ? selected.unit_price_eur : 0;
  item.quote = null;
  item.analysis = analyzeChange(item.requestedConfig, db.listReports(), {
    baseConfig: item.baseConfig,
    costs: db.listCosts(),
    includeAlternatives: false,
  });
  item.workflow1Result = result;
  item.workflow1LastRunId = runId;
  item.updatedAt = createdAt;
  db.sqlite.exec('BEGIN IMMEDIATE');
  try {
    db.saveCase(item);
    db.addAudit({ id: `audit-${randomUUID()}`, caseId: sessionId, type: 'workflow1.synced', actor: 'workflow1',
      detail: JSON.stringify({ round: item.round, runId, ruleVersion: object(result.scope).rule_version,
        evidenceVersion: item.workflow1EvidenceVersion, quoteReady: item.workflow1QuoteReady,
        optionCount: options.length, result, synthetic: true }), createdAt, ruleVersion: item.analysis.ruleVersion, fingerprint });
    db.cacheRequest(sessionId, 'workflow1.sync', fingerprint, result);
    db.sqlite.exec('COMMIT');
  } catch (error) { db.sqlite.exec('ROLLBACK'); throw error; }
  return { status: 200, body: { case: item, replay: false } };
}

function captureSummary(capture: ExtensionCapture): Omit<ExtensionCapture, 'text'> {
  const { text: _text, ...summary } = capture;
  return summary;
}

function mapFindingId(value: unknown): string {
  const key = String(value ?? '');
  return ({ thermal_rise: 'temperature', ingress_protection: 'ip', emc_electrical: 'emc',
    rohs_evidence: 'rohs', electrical_strength: 'electrical-strength', document_update: 'document-update' } as Record<string, string>)[key] ?? key;
}

export function registerWorkflow1(app: Express, db: AppDatabase): void {
  const staticDir = resolve(process.cwd(), 'workflow-1/app/tradetwin/static');
  if (existsSync(staticDir)) {
    app.use('/sales', express.static(staticDir, { index: 'index.html' }));
    // The Python workspace uses absolute /static asset URLs. Keep that layout
    // when it is embedded behind the Node service.
    app.use('/static', express.static(staticDir, { index: false }));
  }

  app.get('/api/workflow1/health', async (_req, res) => {
    try {
      const response = await fetch(`${url()}/api/health`, { signal: AbortSignal.timeout(2000) });
      const data = object(await response.json());
      res.status(response.status).json({ ...data, sharedCaseStore: true });
    } catch {
      res.status(503).json({ ok: false, code: 'WORKFLOW1_UNAVAILABLE', message: '业务分析服务不可用。请启动本地服务后重试。' });
    }
  });

  app.get('/api/workflow1/session/:id', async (req, res) => {
    try {
      const response = await fetch(`${url()}/api/session/${encodeURIComponent(req.params.id)}`, { signal: AbortSignal.timeout(3000) });
      res.status(response.status).type(response.headers.get('content-type') || 'application/json').send(await response.text());
    } catch {
      res.status(503).json({ code: 'WORKFLOW1_UNAVAILABLE', message: '工作流一服务不可用。请稍后重试。' });
    }
  });

  app.post('/api/workflow1/sync', (req, res) => {
    const outcome = syncWorkflow1Result(db, req.body);
    res.status(outcome.status).json(outcome.body);
  });

  app.post('/api/extension/captures/:id/import', async (req, res) => {
    const capture = db.getCapture(req.params.id);
    if (!capture) { res.status(404).json({ code: 'CAPTURE_NOT_FOUND', message: '捕获不存在或已过期' }); return; }
    if (capture.status === 'imported' && capture.caseId) {
      const item = db.getCase(capture.caseId);
      if (!item) { res.status(404).json({ code: 'CAPTURE_CASE_NOT_FOUND', message: '关联案件不存在' }); return; }
      refreshWorkflow1Readiness(item, db);
      res.json({ case: item, replay: true });
      return;
    }
    try {
      const response = await fetch(`${url()}/api/analyze`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: capture.text, session_id: capture.sessionId, channel: 'alibaba_rfq', source: 'extension' }),
        signal: AbortSignal.timeout(60_000),
      });
      if (!response.ok) {
        res.status(502).json({ code: 'WORKFLOW1_ANALYZE_FAILED', message: '询盘分析失败，请检查内容后重试。' });
        return;
      }
      let raw: unknown;
      try { raw = await response.json(); } catch {
        res.status(502).json({ code: 'INVALID_WORKFLOW1_RESULT', message: '工作流一返回了无效结果。' });
        return;
      }
      let result: Record<string, unknown>;
      try { result = parseWorkflow1Result(raw); } catch (error) {
        res.status(502).json({ code: 'INVALID_WORKFLOW1_RESULT', message: error instanceof Error ? error.message : '工作流一结果无效' });
        return;
      }
      if (result.session_id !== capture.sessionId || result.channel !== 'alibaba_rfq') {
        res.status(502).json({ code: 'INVALID_WORKFLOW1_RESULT', message: '工作流一返回的会话或渠道与捕获记录不一致。' });
        return;
      }
      const outcome = syncWorkflow1Result(db, result);
      if (outcome.status !== 200) { res.status(outcome.status).json(outcome.body); return; }
      const syncedCase = outcome.body.case as CaseRecord;
      const imported = db.markCaptureImported(capture.id, syncedCase.id);
      if (!imported) { res.status(410).json({ code: 'CAPTURE_EXPIRED', message: '捕获已过期，请从插件重新提交。' }); return; }
      res.json({ case: syncedCase, replay: outcome.body.replay === true });
    } catch {
      res.status(503).json({ code: 'WORKFLOW1_UNAVAILABLE', message: '业务分析服务暂不可用。请检查本地服务并重试。' });
    }
  });

  const proxy = async (req: Request, res: Response, next: NextFunction) => {
    const targetPath = req.originalUrl.replace(/^\/api\/workflow1/, '/api');
    if (!['GET', 'HEAD'].includes(req.method) && /^\/api\/settings\/mail(?:[/?]|$)/.test(targetPath) && req.headers.origin) {
      let local = false;
      try {
        const origin = new URL(req.headers.origin);
        local = ['http:', 'https:'].includes(origin.protocol) && ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname);
      } catch { /* Invalid Origin is nonlocal. */ }
      if (!local) { res.status(403).json({ code: 'NONLOCAL_ORIGIN', message: '邮箱设置只能从本机工作台修改。' }); return; }
    }
    try {
      const headers = new Headers();
      const contentType = req.headers['content-type'];
      if (contentType) headers.set('content-type', contentType);
      if (req.headers.origin) headers.set('origin', req.headers.origin);
      const response = await fetch(`${url()}${targetPath}`, {
        method: req.method,
        headers,
        body: ['GET', 'HEAD'].includes(req.method) ? undefined : JSON.stringify(req.body ?? {}),
        signal: AbortSignal.timeout(60_000),
      });
      res.status(response.status);
      const responseType = response.headers.get('content-type');
      if (responseType) res.setHeader('content-type', responseType);
      res.send(Buffer.from(await response.arrayBuffer()));
    } catch (error) {
      if (res.headersSent) return next(error);
      res.status(503).json({ code: 'WORKFLOW1_UNAVAILABLE', message: '业务分析服务暂不可用。请检查本地服务并重试，本次分析尚未完成。' });
    }
  };
  app.use('/api/workflow1', proxy);
}

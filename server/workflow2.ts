import { createHash } from 'node:crypto';
import type express from 'express';
import type { CostItem, EvidenceReport, Finding, ProductConfig } from '../shared/types.js';
import { analyzeChange } from './engine.js';
import { AppDatabase } from './db.js';
import { BASE_CONFIG, RULE_VERSION } from './seed.js';

export const WORKFLOW2_CONTRACT_VERSION = 'tradetwin.wf2.v1';
const ASSUMPTION_VERSION = 'COST-DEMO-V0.1';

const TEST_KEYS: Record<string, string> = {
  temperature: 'thermal_rise',
  ip: 'ingress_protection',
  emc: 'emc_electrical',
  'electrical-strength': 'electrical_strength',
  rohs: 'rohs_evidence',
};

const RETEST_NAMES: Record<string, { zh: string; en: string; de: string }> = {
  temperature: { zh: '温升与耐热相关测试', en: 'temperature rise and heat resistance tests', de: 'Erwärmungs- und Wärmebeständigkeitsprüfungen' },
  ip: { zh: '防尘防水（IP）测试', en: 'ingress protection test', de: 'Prüfung der Schutzart' },
  emc: { zh: 'EMC 测试', en: 'EMC testing', de: 'EMV-Prüfung' },
  'electrical-strength': { zh: '电气强度与绝缘复核', en: 'electrical strength and insulation review', de: 'Prüfung der elektrischen Festigkeit und Isolierung' },
  rohs: { zh: 'RoHS / REACH 材料证据复核', en: 'RoHS / REACH material evidence review', de: 'RoHS-/REACH-Materialnachweisprüfung' },
};

const DOCUMENT_NAMES: Record<string, string> = {
  doc: 'DoC',
  label: 'label',
  manual: 'German instructions',
};

type WorkflowConfig = {
  config_id: string;
  power_w: number | null;
  ip_rating: string | null;
  driver: string | null;
};

type WorkflowRequest = {
  contract_version: string;
  request_id: string;
  scope: { market: string; product_scope: string };
  configs: WorkflowConfig[];
};

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value as Record<string, unknown>).sort().map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`;
}

function evidenceVersion(reports: EvidenceReport[], costs: CostItem[]): string {
  return createHash('sha256').update(canonical({ reports, costs })).digest('hex');
}

function sendError(res: express.Response, message: string): void {
  res.status(400).json({ error: message, code: 'BAD_REQUEST' });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function validateRequest(value: unknown): WorkflowRequest | string {
  if (!isRecord(value)) return '请求体必须是对象';
  if (value.contract_version !== WORKFLOW2_CONTRACT_VERSION) return `contract_version 应为 ${WORKFLOW2_CONTRACT_VERSION}`;
  if (typeof value.request_id !== 'string' || !value.request_id.trim()) return 'request_id 必须是非空字符串';
  const scope = value.scope;
  if (!isRecord(scope) || scope.market !== 'EU' || scope.product_scope !== 'indoor_fixed_led_luminaire') {
    return 'scope 仅支持 EU / indoor_fixed_led_luminaire';
  }
  if (!Array.isArray(value.configs) || value.configs.length < 1 || value.configs.length > 3) return 'configs 必须包含 1 到 3 个配置';
  const ids = new Set<string>();
  const configs: WorkflowConfig[] = [];
  for (const [index, raw] of value.configs.entries()) {
    if (!isRecord(raw)) return `configs[${index}] 必须是对象`;
    const configId = raw.config_id;
    if (typeof configId !== 'string' || !configId.trim()) return `configs[${index}].config_id 必须是非空字符串`;
    if (ids.has(configId)) return 'config_id 不能重复';
    ids.add(configId);
    const power = raw.power_w;
    if (power !== null && (typeof power !== 'number' || !Number.isFinite(power) || power <= 0)) return `configs[${index}].power_w 必须是正的有限数字或 null`;
    const ip = raw.ip_rating;
    if (ip !== null && (typeof ip !== 'string' || !/^IP\d{2}$/i.test(ip.trim()))) return `configs[${index}].ip_rating 必须是 IPxx 或 null`;
    const driver = raw.driver;
    if (driver !== null && (typeof driver !== 'string' || !driver.trim())) return `configs[${index}].driver 必须是非空字符串或 null`;
    configs.push({ config_id: configId, power_w: power, ip_rating: typeof ip === 'string' ? ip.trim().toUpperCase() : null, driver: typeof driver === 'string' ? driver.trim() : null });
  }
  return { contract_version: value.contract_version, request_id: value.request_id.trim(), scope: scope as WorkflowRequest['scope'], configs };
}

function envelope(db: AppDatabase): Record<string, unknown> {
  const reports = db.listReports();
  const costs = db.listCosts();
  const report = reports.find((item) => item.id === 'TR-001' && item.status === 'ready' && item.verified && item.testScopes?.temperature);
  const scope = report?.testScopes?.temperature;
  if (!report || !scope || scope.coverage.powerMinW === null || scope.coverage.powerMaxW === null) {
    throw new Error('没有可用于 envelope 的已确认温升范围');
  }
  const page = report.pages.find((item) => item.page === scope.page);
  if (!page || !page.text.trim()) throw new Error('envelope 温升证据页不可用');
  const quote = scope.quote && page.text.includes(scope.quote) ? scope.quote : page.text;
  return {
    contract_version: WORKFLOW2_CONTRACT_VERSION,
    rule_version: `${RULE_VERSION}/${ASSUMPTION_VERSION}`,
    assumption_version: ASSUMPTION_VERSION,
    evidence_version: evidenceVersion(reports, costs),
    product: { model: BASE_CONFIG.model, power_w: BASE_CONFIG.powerW, ip_rating: BASE_CONFIG.ip, driver: BASE_CONFIG.driver },
    coverage: {
      report_id: report.id,
      power_range_w: { min: scope.coverage.powerMinW, max: scope.coverage.powerMaxW },
      ip_rating: scope.coverage.ipLevels[0] ?? BASE_CONFIG.ip,
      driver: scope.coverage.drivers[0] ?? BASE_CONFIG.driver,
      evidence: [{ document_id: report.id, page: scope.page, quote }],
    },
  };
}

function mapStatus(finding: Finding): string {
  if (finding.status === 'reuse') return 'COVERED';
  if (finding.status === 'retest') return 'NEEDS_RETEST';
  if (finding.status === 'update') return 'DOCUMENT_UPDATE';
  return 'MANUAL_REVIEW';
}

function mapFinding(finding: Finding): Record<string, unknown> {
  const evidence = finding.evidence.map((item) => ({ document_id: item.reportId, page: item.page, quote: item.quote }));
  const status = mapStatus(finding) === 'COVERED' && evidence.length === 0 ? 'MANUAL_REVIEW' : mapStatus(finding);
  return {
    item_key: TEST_KEYS[finding.itemId] ?? finding.itemId,
    item: finding.title,
    status,
    reason: finding.reason,
    evidence,
    rule_refs: finding.ruleIds,
  };
}

function analyzeConfig(db: AppDatabase, input: WorkflowConfig, currentEvidenceVersion: string): Record<string, unknown> {
  const config: ProductConfig = {
    ...BASE_CONFIG,
    powerW: input.power_w,
    ip: input.ip_rating,
    driver: input.driver,
    material: BASE_CONFIG.material,
  };
  const analysis = analyzeChange(config, db.listReports(), {
    costs: db.listCosts(),
    includeAlternatives: false,
  });
  const findings = analysis.findings.map(mapFinding);
  const retestItems = analysis.requiredTests.map((id) => {
    const cost = db.listCosts().find((item) => item.id === id);
    if (!cost) return null;
    return { test_key: TEST_KEYS[id] ?? id, name: RETEST_NAMES[id] ?? { zh: id, en: `additional test (${id})`, de: `Zusatzprüfung (${id})` }, cost_eur: cost.feeEur, lab_days: cost.days };
  }).filter((item): item is NonNullable<typeof item> => !!item);
  const knownCost = retestItems.reduce((sum, item) => sum + item.cost_eur, 0);
  const hasReview = analysis.reviewCount > 0 || findings.some((finding) => finding.status === 'MANUAL_REVIEW' || finding.status === 'NOT_ENOUGH_EVIDENCE');
  const updates = analysis.documentUpdates.map((item) => DOCUMENT_NAMES[item] ?? item);
  return {
    config_id: input.config_id,
    config: { power_w: input.power_w, ip_rating: input.ip_rating, driver: input.driver },
    findings,
    retest_items: retestItems,
    document_updates: updates,
    estimated_cost_eur: hasReview ? null : analysis.totalCostEur,
    estimated_days: hasReview ? null : analysis.leadTimeDays,
    known_cost_eur: knownCost,
    days_breakdown: {
      new_driver_sample: 0,
      lab_parallel: analysis.calculation.parallelDays,
      document_update: analysis.calculation.documentationDays,
    },
    manual_review_required: hasReview,
    owner_actions: hasReview ? [{ owner_role: 'QUALITY_COMPLIANCE', action: '人工核对证据覆盖和补测条件' }] : [],
    issues: [],
    synthetic: true,
    human_confirmed: false,
    source_type: 'synthetic_demo_mapping',
    assumption_version: ASSUMPTION_VERSION,
    evidence_version: currentEvidenceVersion,
  };
}

export function registerWorkflow2(app: express.Express, db: AppDatabase): void {
  app.get('/api/workflow2/envelope', (_req, res) => {
    try {
      res.json(envelope(db));
    } catch (error) {
      sendError(res, error instanceof Error ? error.message : '无法生成 workflow2 envelope');
    }
  });
  app.post('/api/workflow2/evaluate', (req, res) => {
    const parsed = validateRequest(req.body);
    if (typeof parsed === 'string') {
      sendError(res, parsed);
      return;
    }
    const reports = db.listReports();
    const costs = db.listCosts();
    const version = evidenceVersion(reports, costs);
    res.json({
      contract_version: WORKFLOW2_CONTRACT_VERSION,
      rule_version: `${RULE_VERSION}/${ASSUMPTION_VERSION}`,
      assumption_version: ASSUMPTION_VERSION,
      request_id: parsed.request_id,
      evidence_version: version,
      scope: parsed.scope,
      results: parsed.configs.map((item) => analyzeConfig(db, item, version)),
    });
  });
}

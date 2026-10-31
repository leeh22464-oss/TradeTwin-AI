import { createHash } from 'node:crypto';
import type {
  AnalysisResult,
  Alternative,
  CostItem,
  EvidenceRef,
  EvidenceReport,
  Finding,
  ProductConfig,
  RuntimeKnowledgeContext,
} from '../shared/types';
import { BASE_CONFIG, RULE_VERSION, seedCosts, seedReports } from './seed';

export type AnalyzeOptions = {
  baseConfig?: ProductConfig;
  commitment?: string;
  costs?: CostItem[];
  includeAlternatives?: boolean;
  policy?: {
    requireEmcReview?: boolean;
    driverPreparationDays?: number;
    ruleIds?: Record<string, string[]>;
    modelAliases?: Record<string, string[]>;
  };
  knowledgeContext?: RuntimeKnowledgeContext;
};

const TEST_TITLES: Record<string, string> = {
  temperature: '温升与耐热相关测试',
  ip: '防尘防水测试',
  emc: 'EMC 测试',
  rohs: 'RoHS / REACH 材料证据复核',
  'electrical-strength': '电气强度与绝缘复核',
};

const TEST_RULES: Record<string, string[]> = {
  temperature: ['R-POWER-001', 'R-TEMP-001'],
  ip: ['R-IP-001', 'R-IP-002'],
  emc: ['R-EMC-001'],
  rohs: ['R-MATERIAL-001', 'R-ROHS-001'],
  'electrical-strength': ['R-DRIVER-001'],
};

const DOCUMENTS = [
  { id: 'doc', title: 'DoC 更新', kind: 'doc' as const, ruleKey: 'doc', rule: 'R-DOC-001', reason: '产品配置发生变化，需要更新 EU DoC。' },
  { id: 'label', title: '产品标签更新', kind: 'label' as const, ruleKey: 'label', rule: 'R-LABEL-001', reason: '功率或防护等级发生变化，需要更新产品标签。' },
  { id: 'manual', title: '德语安装说明书更新', kind: 'manual' as const, ruleKey: 'manual', rule: 'R-MANUAL-001', reason: '规格、安装环境或市场语言需要同步到说明书。' },
] as const;

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value as Record<string, unknown>).sort().map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`;
}

function hashId(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex').slice(0, 16);
}

function normIp(ip: string | null | undefined): string | null {
  if (!ip) return null;
  const match = ip.toUpperCase().replace(/\s+/g, '').match(/^IP\d{2}$/);
  return match ? match[0] : ip.toUpperCase().replace(/\s+/g, '');
}

function sameValue(a: string | null | undefined, b: string | null | undefined): boolean {
  return (a ?? '').trim().toUpperCase() === (b ?? '').trim().toUpperCase();
}

function hasValue(value: string | null | undefined): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function seriesMatches(series: string | null, model: string | null, modelAliases: Record<string, string[]> = {}): boolean {
  if (!series || !model) return false;
  const normalizedSeries = series.toUpperCase();
  const normalizedModel = model.toUpperCase();
  if (normalizedModel === normalizedSeries || normalizedModel.startsWith(`${normalizedSeries}-`)) return true;
  // Aliases are an explicit, bounded compatibility declaration. Never infer
  // compatibility from a shared prefix alone (e.g. NL-L24 is not NL-L).
  const forward = modelAliases[model] ?? modelAliases[normalizedModel] ?? [];
  if (forward.some((alias) => alias.toUpperCase() === normalizedSeries)) return true;
  // Accept the explicitly declared reverse direction as well, so a runtime
  // profile can describe either "NL-L -> NL-L24" or "NL-L24 -> NL-L".
  return Object.entries(modelAliases).some(([alias, values]) => alias.toUpperCase() === normalizedSeries
    && values.some((value) => value.toUpperCase() === normalizedModel));
}

function inRange(value: number | null, min: number | null, max: number | null): boolean {
  return value !== null && (min === null || value >= min) && (max === null || value <= max);
}

const TEST_PAGE_MARKERS: Record<string, RegExp> = {
  temperature: /温升|耐热|temperature/i,
  ip: /防护|防尘|防水|IP\d{2}/i,
  emc: /EMC/i,
  rohs: /RoHS|REACH|材料/i,
  'electrical-strength': /电气强度|绝缘|electrical/i,
};

function sourcePage(report: EvidenceReport | undefined, test?: string): EvidenceReport['pages'][number] | undefined {
  if (!report) return undefined;
  const pages = report.pages.filter((page) => page.text.trim().length > 0);
  if (!test) return pages[0];
  return pages.find((page) => TEST_PAGE_MARKERS[test]?.test(page.text)) ?? pages[0];
}

function scopeFor(report: EvidenceReport | undefined, test: string): { coverage: EvidenceReport['coverage']; page: number; quote?: string } | undefined {
  if (!report) return undefined;
  const scoped = report.testScopes?.[test];
  if (scoped) return scoped;
  // A confirmed report with exactly one declared test is an unambiguous
  // project scope. Multi-test aggregate coverage stays manual-review-only
  // unless each project has its own testScopes entry and page.
  if (report.coverage.tests.length !== 1 || report.coverage.tests[0] !== test) return undefined;
  const page = sourcePage(report, test);
  return page ? { coverage: report.coverage, page: page.page } : undefined;
}

function scopePageMissing(report: EvidenceReport | undefined, test: string): boolean {
  const scoped = scopeFor(report, test);
  if (!scoped) return false;
  const page = report?.pages.find((item) => item.page === scoped.page);
  return !page || !page.text.trim();
}

function evidenceFor(report: EvidenceReport | undefined, test?: string): EvidenceRef[] {
  if (!report) return [];
  if (test) {
    const scoped = scopeFor(report, test);
    if (!scoped) return [];
    const page = report.pages.find((item) => item.page === scoped.page);
    if (!page || !page.text.trim()) return [];
    const quote = scoped.quote && page.text.includes(scoped.quote) ? scoped.quote : page.text;
    return [{ reportId: report.id, page: scoped.page, quote, ...(report.knowledgeSource ? { source: report.knowledgeSource } : {}) }];
  }
  const source = sourcePage(report);
  return source ? [{ reportId: report.id, page: source.page, quote: source.text, ...(report.knowledgeSource ? { source: report.knowledgeSource } : {}) }] : [];
}

function testCost(test: string, costs: CostItem[] = seedCosts): CostItem | undefined {
  return costs.find((cost) => cost.id === test);
}

function isChanged(config: ProductConfig, base: ProductConfig): boolean {
  return !sameValue(config.model, base.model) || config.powerW !== base.powerW || !sameValue(normIp(config.ip), normIp(base.ip))
    || !sameValue(config.driver, base.driver) || !sameValue(config.material, base.material) || !sameValue(config.market, base.market);
}

function requiredFieldsForCoverage(c: EvidenceReport['coverage'], config: ProductConfig, test: string, modelAliases: Record<string, string[]> = {}): string[] {
  const missing: string[] = [];
  if (!seriesMatches(c.series, config.model, modelAliases)) missing.push('型号系列');
  const powerRelevant = test === 'temperature' || test === 'emc' || test === 'electrical-strength';
  if (powerRelevant && (c.powerMinW !== null || c.powerMaxW !== null)) {
    if (config.powerW === null) missing.push('功率当前值缺失');
    else if (!inRange(config.powerW, c.powerMinW, c.powerMaxW)) missing.push('功率范围不匹配');
  } else if (powerRelevant) missing.push('功率范围未定义');
  if (test === 'ip' && c.ipLevels.length === 0) missing.push('防护等级范围未定义');
  else if (c.ipLevels.length > 0) {
    if (!config.ip) missing.push('防护等级当前值缺失');
    else if (!c.ipLevels.some((level) => sameValue(level, config.ip))) missing.push('防护等级不匹配');
  }
  if ((test === 'emc' || test === 'electrical-strength') && c.drivers.length === 0) missing.push('驱动覆盖范围未定义');
  else if (c.drivers.length > 0) {
    if (!config.driver) missing.push('驱动电源当前值缺失');
    else if (!c.drivers.some((driver) => sameValue(driver, config.driver))) missing.push('驱动电源不匹配');
  }
  if ((test === 'emc' || test === 'rohs') && c.materials.length === 0) missing.push('材料覆盖范围未定义');
  else if (c.materials.length > 0) {
    if (!config.material) missing.push('材料当前值缺失');
    else if (!c.materials.some((material) => sameValue(material, config.material))) missing.push('材料组合不匹配');
  }
  if (c.markets.length === 0) missing.push('目标市场范围未定义');
  else if (!config.market) missing.push('目标市场当前值缺失');
  else if (!c.markets.some((market) => sameValue(market, config.market))) missing.push('目标市场不匹配');
  return missing;
}

function findReport(reports: EvidenceReport[], test: string, config: ProductConfig, modelAliases: Record<string, string[]> = {}): EvidenceReport | undefined {
  // Do not let an unrelated uploaded report win merely because its range
  // happens to contain the requested value. A report is only applicable when
  // its scoped series matches the current model or an explicitly declared
  // alias; otherwise the caller must receive a missing-applicable-evidence
  // review instead of a false retest conclusion.
  const candidates = reports.filter((report) => {
    const scoped = scopeFor(report, test);
    return !!scoped && seriesMatches(scoped.coverage.series, config.model, modelAliases);
  });
  const score = (report: EvidenceReport): number => {
    const scoped = scopeFor(report, test);
    const missing = scoped ? requiredFieldsForCoverage(scoped.coverage, config, test, modelAliases) : ['测试项目范围未定义'];
    let value = report.status === 'ready' && report.verified ? 100_000 : 0;
    // A fully matching scope wins over an out-of-range scope. When all
    // candidates are out of range, prefer the verified boundary nearest to
    // the requested power (and the broader range when the boundary ties),
    // rather than letting lexical report IDs decide which A option appears.
    if (missing.length === 0) value += 1_000_000;
    value -= missing.length * 100_000;
    const power = config.powerW;
    const min = scoped?.coverage.powerMinW ?? null;
    const max = scoped?.coverage.powerMaxW ?? null;
    const span = min !== null && max !== null ? max - min : 0;
    if (power !== null && max !== null && power > max) value += max * 100 + span;
    else if (power !== null && min !== null && power < min) value += (100_000 - min * 100) + span;
    else if (power !== null && inRange(power, min, max)) value += 50_000 + span;
    if (report.testScopes?.[test]) value += 2;
    return value;
  };
  return candidates.sort((a, b) => score(b) - score(a) || a.id.localeCompare(b.id))[0];
}

function requiredFields(report: EvidenceReport, config: ProductConfig, test: string, modelAliases: Record<string, string[]> = {}): string[] {
  const scoped = scopeFor(report, test);
  return scoped ? requiredFieldsForCoverage(scoped.coverage, config, test, modelAliases) : ['测试项目范围未定义'];
}

function rulesFor(options: AnalyzeOptions, key: string, fallback: string[], categories: string[] = []): string[] {
  const policyRules = options.policy?.ruleIds ?? {};
  const direct = policyRules[key];
  if (direct && direct.length > 0) return [...direct];
  const mapped = categories.flatMap((category) => policyRules[category] ?? []);
  return mapped.length > 0 ? [...new Set(mapped)] : [...fallback];
}

function rangeText(min: number | null, max: number | null, unit = 'W'): string {
  if (min !== null && max !== null) return `${min}${unit}–${max}${unit}`;
  if (min !== null) return `≥${min}${unit}`;
  if (max !== null) return `≤${max}${unit}`;
  return '未声明';
}

function reportReference(report: EvidenceReport | undefined, test: string): string {
  if (!report) return '当前证据报告';
  const scope = scopeFor(report, test);
  return `${report.id}${scope ? ` 第${scope.page}页` : ''}`;
}

function documentPage(report: EvidenceReport, documentId: string): EvidenceReport['pages'][number] | undefined {
  const marker: Record<string, RegExp> = {
    doc: /DoC|Declaration|Konformität/i,
    label: /标签|label|Kennzeichnung/i,
    manual: /说明书|instructions|Anleitung/i,
  };
  const pages = report.pages.filter((page) => page.text.trim().length > 0);
  return pages.find((page) => marker[documentId]?.test(page.text)) ?? pages[0];
}

function documentEvidence(report: EvidenceReport | undefined, documentId: string): EvidenceRef[] {
  if (!report) return [];
  const page = documentPage(report, documentId);
  return page ? [{ reportId: report.id, page: page.page, quote: page.text, ...(report.knowledgeSource ? { source: report.knowledgeSource } : {}) }] : [];
}

function findDocumentReport(reports: EvidenceReport[], documentId: string, config: ProductConfig, aliases: Record<string, string[]>): EvidenceReport | undefined {
  const kind = documentId === 'doc' ? 'doc' : documentId;
  const candidates = reports.filter((report) => report.kind === kind || report.coverage.tests.includes(documentId));
  return candidates.sort((a, b) => {
    const score = (report: EvidenceReport): number => {
      let value = report.status === 'ready' && report.verified && report.pages.some((page) => page.text.trim()) ? 100 : 0;
      if (seriesMatches(report.coverage.series, config.model, aliases)) value += 10;
      if (report.coverage.markets.some((market) => sameValue(market, config.market))) value += 2;
      return value;
    };
    return score(b) - score(a) || a.id.localeCompare(b.id);
  })[0];
}

function formatConfigValue(value: string | number | null): string {
  return value === null || value === '' ? '待确认' : String(value);
}

function createFinding(
  id: string,
  itemId: string,
  title: string,
  category: Finding['category'],
  status: Finding['status'],
  reason: string,
  rules: string[],
  report: EvidenceReport | undefined,
  test: string,
  costs: CostItem[],
): Finding {
  const cost = testCost(itemId, costs);
  return {
    id, itemId, title, category, status, reason, ruleIds: rules,
    evidence: evidenceFor(report, test), feeEur: status === 'retest' ? (cost?.feeEur ?? null) : null,
    days: status === 'retest' ? (cost?.days ?? null) : null,
  };
}

function analyzeCore(config: ProductConfig, reports: EvidenceReport[], options: AnalyzeOptions, includeAlternatives: boolean): AnalysisResult {
  const base = options.baseConfig ?? BASE_CONFIG;
  const costs = options.costs ?? seedCosts;
  const commitment = options.commitment ?? '';
  const aliases = options.policy?.modelAliases ?? {};
  const ruleVersion = options.knowledgeContext?.version ?? RULE_VERSION;
  const findings: Finding[] = [];
  const requiredTests: string[] = [];
  const reusedTests: string[] = [];
  const warnings: string[] = ['费用、周期与报告均为合成演示数据，最终以检测机构意见和实验室排期为准。'];

  const changedPower = config.powerW !== base.powerW;
  const changedIp = !sameValue(normIp(config.ip), normIp(base.ip));
  const driverDiff = !sameValue(config.driver, base.driver);
  const changedDriver = driverDiff && hasValue(config.driver) && hasValue(base.driver);
  const unknownDriver = driverDiff && !changedDriver;
  const changedMaterial = !sameValue(config.material, base.material);
  const changedMarket = !sameValue(config.market, base.market);
  const changedModel = !sameValue(config.model, base.model);
  const configChanged = changedPower || changedIp || driverDiff || changedMaterial || changedMarket || changedModel;
  const requireEmcReview = options.policy?.requireEmcReview ?? true;

  const tests = ['temperature', 'ip', 'emc', 'rohs', 'electrical-strength'];
  for (const test of tests) {
    const report = findReport(reports, test, config, aliases);
    const scope = scopeFor(report, test);
    const coverage = scope?.coverage;
    const title = TEST_TITLES[test];
    const reportReady = !!report && report.status === 'ready' && report.verified;
    const missing = report ? requiredFields(report, config, test, aliases) : ['报告'];
    const pageMissing = scopePageMissing(report, test);
    const definitionGap = missing.some((item) => item.includes('未定义') || item.includes('当前值缺失')) || pageMissing;
    let status: Finding['status'] = 'reuse';
    let reason = `${reportReference(report, test)} 已验证，当前配置在该测试项目的覆盖条件内。`;

    if (!reportReady) {
      status = 'review';
      reason = report ? `${reportReference(report, test)} 缺失、未验证或状态不可用，必须人工核验，不能自动放行。` : '缺少该测试项目的证据报告，必须人工核验。';
    } else if (pageMissing) {
      status = 'review';
      reason = `${reportReference(report, test)} 声明的测试项目页码不存在，证据引用无效，必须人工核验。`;
    } else if (definitionGap) {
      status = 'review';
      reason = `证据覆盖条件不完整：${missing.join('、')}；必须人工核验，不能自动放行。`;
    } else if (test === 'temperature') {
      if (config.powerW === null) {
        status = 'review'; reason = '缺少当前功率，不能确认温升报告覆盖范围。';
      } else if (missing.length > 0) {
        status = 'retest';
        reason = missing.includes('功率范围不匹配') && coverage
          ? `当前功率 ${config.powerW}W 超出 ${reportReference(report, test)} 的温升覆盖范围 ${rangeText(coverage.powerMinW, coverage.powerMaxW)}。`
          : `${reportReference(report, test)} 的温升覆盖条件不匹配：${missing.join('、')}。`;
      }
    } else if (test === 'ip') {
      if (!config.ip) {
        status = 'review'; reason = '缺少当前防护等级，不能确认防尘防水报告覆盖范围。';
      } else if (missing.length > 0) {
        status = 'retest';
        reason = `当前防护等级 ${config.ip} 未被 ${reportReference(report, test)} 声明的覆盖条件覆盖：${missing.join('、')}。`;
      }
    } else if (test === 'emc') {
      if (!configChanged && missing.length === 0) {
        status = 'reuse'; reason = `${reportReference(report, test)} 已验证，基线配置的 EMC 条件全部匹配，可沿用。`;
      } else if (unknownDriver) {
        status = 'review'; reason = '当前或基线驱动电源缺失/未知，不能判断是否发生了已知驱动变更，必须人工核验。';
      } else if (changedDriver && missing.length === 0) {
        status = 'reuse'; reason = `新的已验证 EMC 证据 ${reportReference(report, test)} 覆盖当前驱动、功率、材料和市场条件，可沿用。`;
      } else if (changedDriver) {
        status = 'retest'; reason = `驱动电源变化，${reportReference(report, test)} 的 EMC 覆盖条件不匹配，需要重新测试：${missing.join('、')}。`;
      } else if (requireEmcReview) {
        status = 'review'; reason = `EMC 配置发生变化且驱动未变，${reportReference(report, test)} 只能作为线索，不能只因驱动相同就沿用；需人工复核${missing.length ? `（${missing.join('、')}）` : ''}。`;
      } else if (missing.length > 0) {
        status = 'review'; reason = `EMC 独立覆盖条件未满足：${missing.join('、')}；不能只因驱动相同就沿用。`;
      }
    } else if (test === 'rohs') {
      if (changedMaterial && missing.length > 0) {
        status = 'retest'; reason = `材料组合变化，${reportReference(report, test)} 不覆盖当前材料，需要重新核对 RoHS / REACH 证据：${missing.join('、')}。`;
      } else if (missing.length > 0) {
        status = changedMaterial ? 'retest' : 'review';
        reason = `RoHS 材料证据不覆盖：${missing.join('、')}。`;
      }
    } else if (test === 'electrical-strength') {
      if (changedDriver && missing.length > 0) {
        status = 'retest'; reason = `驱动电源变化，${reportReference(report, test)} 的电气安全覆盖条件不匹配，需要复核：${missing.join('、')}。`;
      } else if (missing.length > 0) {
        status = changedPower ? 'retest' : 'review';
        reason = `电气强度证据不覆盖：${missing.join('、')}。`;
      }
    }

    if (status === 'retest' && !testCost(test, costs)) {
      status = 'review';
      reason = `${title}需要补测，但缺少对应费用与周期数据，必须人工核验。`;
    }

    const finding = createFinding(
      `finding-${test}`, test, title, 'compliance', status, reason,
      rulesFor(options, test, TEST_RULES[test], test === 'emc' ? ['mapping', 'driverReuse', 'coverage'] : ['coverage', 'mapping', 'minimumRetest']),
      report, test, costs,
    );
    findings.push(finding);
    if (status === 'retest') requiredTests.push(test);
    if (status === 'reuse') reusedTests.push(test);
  }

  if (configChanged) {
    const documentCost = testCost('document-update', costs);
    for (const doc of DOCUMENTS) {
      const report = findDocumentReport(reports, doc.id, config, aliases);
      const evidence = documentEvidence(report, doc.id);
      const documentEvidenceReady = !!report && report.status === 'ready' && report.verified && evidence.length > 0;
      const documentStatus: Finding['status'] = documentCost && documentEvidenceReady ? 'update' : 'review';
      const evidenceHint = report && evidence[0] ? ` 参考 ${report.id} 第${evidence[0].page}页。` : '';
      findings.push({
        id: `finding-${doc.id}`, itemId: doc.id, title: doc.title, category: 'documents', status: documentStatus,
        reason: !documentEvidenceReady
          ? `${doc.reason} 当前文件证据缺失或未验证，需要创建/补齐并人工确认。`
          : documentCost ? `${doc.reason}${evidenceHint}` : `${doc.reason} 但缺少文档更新费用与周期数据，必须人工核验。`,
        ruleIds: rulesFor(options, doc.ruleKey, [doc.rule], ['documentUpdate']), evidence, feeEur: null, days: documentCost?.days ?? null,
      });
    }
  }

  // A known driver change requires a real preparation cost row. The runtime
  // profile supplies the three-day synthetic row; missing or malformed rows
  // must block quoting instead of silently becoming a zero-cost estimate.
  const prepCost = changedDriver ? testCost('driver-preparation', costs) : undefined;
  const prepCostValid = !changedDriver || Boolean(
    prepCost
      && Number.isFinite(prepCost.feeEur) && prepCost.feeEur >= 0
      && Number.isFinite(prepCost.days) && Number.isInteger(prepCost.days) && prepCost.days > 0,
  );
  const configuredPreparationDays = options.policy?.driverPreparationDays;
  const preparationDays = !changedDriver ? 0
    : prepCostValid
      ? (typeof configuredPreparationDays === 'number' && Number.isFinite(configuredPreparationDays) && configuredPreparationDays > 0
        ? configuredPreparationDays
        : prepCost!.days)
      : undefined;
  if (changedDriver && !prepCostValid) {
    findings.push({
      id: 'finding-driver-preparation', itemId: 'driver-preparation', title: '新驱动打样与准备', category: 'compliance', status: 'review',
      reason: '已确认当前与基线驱动不同，但缺少有效的 driver-preparation 费用或周期数据，必须人工核验，不能自动报价。',
      ruleIds: rulesFor(options, 'driver-preparation', ['R-DRIVER-001'], ['driverReuse', 'mapping']), evidence: [], feeEur: null, days: null,
    });
    warnings.push('驱动更换的费用或周期数据缺失/无效，已阻止自动报价。');
  }

  const hasDeliveryCommitment = /(原交期|按原交期|保证(?:交期|合规|认证)|承诺(?:交期|合规|认证)|guarantee|guaranteed|same delivery|deliver on time)/i.test(commitment);
  const withholdLanguage = /(暂不承诺|不承诺|不要承诺|排期确认后|待.*确认|do not commit|without committing)/i.test(commitment);
  const hasRetestOrReview = findings.some((finding) => finding.status === 'retest' || finding.status === 'review');
  if (hasDeliveryCommitment && hasRetestOrReview && !withholdLanguage) {
    findings.push({
      id: 'finding-contract-delivery', itemId: 'contract-delivery', title: '交期承诺风险', category: 'contract', status: 'warning',
      reason: '补测或排期仍未确认，不应承诺原交期；建议改为“测试排期确认后告知”。', ruleIds: rulesFor(options, 'contract-delivery', ['R-CONTRACT-001'], ['contract', 'quoteAssumption']), evidence: [], feeEur: null, days: null,
    });
    warnings.push('检测排期尚未确认，报价回复不得承诺原交期。');
  }
  if (withholdLanguage) warnings.push('已记录暂不承诺具体交期，回复应等待实验室排期确认。');

  const uniqueRetests = [...new Set(requiredTests)];
  const uniqueDocs = [...new Set(findings.filter((finding) => finding.category === 'documents').map((finding) => finding.itemId))];
  const testCostItems = uniqueRetests.map((id) => testCost(id, costs)).filter((item): item is CostItem => !!item);
  const totalCostEur = testCostItems.reduce((sum, item) => sum + item.feeEur, 0) + (prepCostValid ? (prepCost?.feeEur ?? 0) : 0);
  const parallelDays = testCostItems.length > 0 ? Math.max(...testCostItems.map((item) => item.days)) : 0;
  const documentationDays = uniqueDocs.length > 0 ? (testCost('document-update', costs)?.days ?? 2) : 0;
  const estimatedDays = parallelDays + (preparationDays ?? 0) + documentationDays;
  const reviewCount = findings.filter((finding) => finding.status === 'review').length;
  const leadTimeDays = reviewCount > 0 ? null : estimatedDays;
  const confidence = reviewCount > 0 ? Math.max(0.55, 0.9 - reviewCount * 0.1) : (hasRetestOrReview ? 0.93 : 0.98);
  const canQuote = reviewCount === 0;
  const testFormula = `max(${testCostItems.length ? testCostItems.map((item) => item.days).join(',') : 0})`;
  const formulaParts: string[] = [];
  if (changedDriver && preparationDays === undefined) formulaParts.push('驱动打样待核验');
  else if (preparationDays !== undefined && preparationDays > 0) formulaParts.push(`${preparationDays}（驱动打样）`);
  formulaParts.push(testFormula);
  if (documentationDays > 0) formulaParts.push(`${documentationDays}（文件更新）`);
  const formula = `${formulaParts.join(' + ')} = ${leadTimeDays ?? '待人工核验'} 个工作日${reviewCount > 0 ? `；已知估算 ${estimatedDays} 个工作日，人工核验后确认` : ''}`;

  const resultWithoutAlternatives: AnalysisResult = {
    id: '', ruleVersion, config: { ...config }, findings, requiredTests: uniqueRetests,
    reusedTests: [...new Set(reusedTests)], documentUpdates: uniqueDocs, reviewCount, totalCostEur,
    leadTimeDays, canQuote, confidence, warnings, alternatives: [],
    calculation: { parallelDays, documentationDays, preparationDays, estimatedDays, formula },
    ...(options.knowledgeContext ? { knowledgeContext: options.knowledgeContext } : {}),
  };

  const fingerprintInput = {
    ruleVersion, config, base, commitment, costs, policy: options.policy ?? null,
    knowledgeContext: options.knowledgeContext ?? null,
    reports: reports.map((report) => ({ id: report.id, status: report.status, verified: report.verified, coverage: report.coverage, testScopes: report.testScopes, pages: report.pages, knowledgeSource: report.knowledgeSource })),
    findings, requiredTests: uniqueRetests, documentUpdates: uniqueDocs,
  };
  resultWithoutAlternatives.id = `analysis-${hashId(fingerprintInput)}`;

  if (includeAlternatives && configChanged) {
    const temperatureReport = findReport(reports, 'temperature', config, aliases);
    const temperatureScope = scopeFor(temperatureReport, 'temperature');
    const upperBound = temperatureScope?.coverage.powerMaxW ?? null;
    const temperatureFinding = findings.find((finding) => finding.itemId === 'temperature');
    const hasOutOfRangeTemperature = config.powerW !== null && upperBound !== null && config.powerW > upperBound
      && temperatureFinding?.status === 'retest';
    if (hasOutOfRangeTemperature) {
      const alternativeAConfig: ProductConfig = { ...config, powerW: upperBound };
      const alternativeBConfig: ProductConfig = { ...config };
      // Do not offer a lower-power option merely because the requested power
      // is above a range. If another constraint (for example a changed
      // driver) still forces the same temperature retest, the option has no
      // compliance or commercial benefit and must not be shown.
      const alternativeA = analyzeCore(alternativeAConfig, reports, { ...options, baseConfig: base, includeAlternatives: false }, false);
      const alternativeTemperature = alternativeA.findings.find((finding) => finding.itemId === 'temperature');
      const temperatureRetestRemoved = alternativeTemperature?.status === 'reuse';
      const testsOrCostReduced = alternativeA.requiredTests.length < requiredTests.length
        || alternativeA.totalCostEur < totalCostEur;
      if (temperatureRetestRemoved && testsOrCostReduced) {
        const buildAlternative = (id: 'A' | 'B', alternativeConfig: ProductConfig, analyzed?: AnalysisResult): Alternative => {
          const alternative = analyzed ?? analyzeCore(alternativeConfig, reports, { ...options, baseConfig: base, includeAlternatives: false }, false);
          const quoteSummary = alternative.leadTimeDays === null
            ? `预计费用 €${alternative.totalCostEur.toLocaleString('en-US')}（示意），存在待人工核验项，无法自动承诺交期。`
            : `预计 ${alternative.leadTimeDays} 个工作日，费用 €${alternative.totalCostEur.toLocaleString('en-US')}（示意）。`;
          const requested = `${formatConfigValue(alternativeConfig.powerW)} / ${formatConfigValue(alternativeConfig.ip)}`;
          return {
            id, label: `方案 ${id}`, config: alternativeConfig, totalCostEur: alternative.totalCostEur,
            leadTimeDays: alternative.leadTimeDays, requiredTests: alternative.requiredTests,
            estimatedLeadTimeDays: alternative.calculation.estimatedDays,
            summary: `${quoteSummary} 配置 ${requested}；${alternative.requiredTests.map((test) => TEST_TITLES[test]).join('、') || '无需新增测试'}。`,
          };
        };
        resultWithoutAlternatives.alternatives = [buildAlternative('A', alternativeAConfig, alternativeA), buildAlternative('B', alternativeBConfig)];
      }
    }
  }
  return resultWithoutAlternatives;
}

export function analyzeChange(config: ProductConfig, reports: EvidenceReport[] = seedReports, options: AnalyzeOptions = {}): AnalysisResult {
  return analyzeCore({ ...config, ip: normIp(config.ip) }, reports, options, options.includeAlternatives !== false);
}

// Keep the public engine API stable while the parser lives in its own module.
export { parseInquiryChange as parseLocalChange } from './inquiry.js';

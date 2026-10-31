import { createHash } from 'node:crypto';
import type {
  AnalysisResult,
  Alternative,
  CostItem,
  EvidenceRef,
  EvidenceReport,
  Finding,
  ProductConfig,
} from '../shared/types';
import { BASE_CONFIG, RULE_VERSION, seedCosts, seedReports } from './seed';

type AnalyzeOptions = {
  baseConfig?: ProductConfig;
  commitment?: string;
  costs?: CostItem[];
  includeAlternatives?: boolean;
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

const REPORT_FOR_TEST: Record<string, string> = {
  temperature: 'TR-001',
  ip: 'TR-001',
  'electrical-strength': 'TR-001',
  emc: 'TR-002',
  rohs: 'TR-003',
};

const DOCUMENTS = [
  { id: 'doc', title: 'DoC 更新', reportId: 'DOC-001', rule: 'R-DOC-001', reason: '产品配置发生变化，需要更新 EU DoC。' },
  { id: 'label', title: '产品标签更新', reportId: 'LABEL-001', rule: 'R-LABEL-001', reason: '功率或防护等级发生变化，需要更新产品标签。' },
  { id: 'manual', title: '德语安装说明书更新', reportId: 'MANUAL-001', rule: 'R-MANUAL-001', reason: '规格、安装环境或市场语言需要同步到说明书。' },
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

function seriesMatches(series: string | null, model: string | null): boolean {
  if (!series || !model) return false;
  return model.toUpperCase() === series.toUpperCase() || model.toUpperCase().startsWith(`${series.toUpperCase()}-`);
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
    return [{ reportId: report.id, page: scoped.page, quote }];
  }
  const source = sourcePage(report);
  return source ? [{ reportId: report.id, page: source.page, quote: source.text }] : [];
}

function testCost(test: string, costs: CostItem[] = seedCosts): CostItem | undefined {
  return costs.find((cost) => cost.id === test);
}

function isChanged(config: ProductConfig, base: ProductConfig): boolean {
  return !sameValue(config.model, base.model) || config.powerW !== base.powerW || !sameValue(normIp(config.ip), normIp(base.ip))
    || !sameValue(config.driver, base.driver) || !sameValue(config.material, base.material) || !sameValue(config.market, base.market);
}

function requiredFieldsForCoverage(c: EvidenceReport['coverage'], config: ProductConfig, test: string): string[] {
  const missing: string[] = [];
  if (!seriesMatches(c.series, config.model)) missing.push('型号系列');
  if (test !== 'rohs' && (c.powerMinW !== null || c.powerMaxW !== null)) {
    if (config.powerW === null) missing.push('功率当前值缺失');
    else if (!inRange(config.powerW, c.powerMinW, c.powerMaxW)) missing.push('功率范围不匹配');
  } else if (test !== 'rohs') missing.push('功率范围未定义');
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

function findReport(reports: EvidenceReport[], test: string, config: ProductConfig): EvidenceReport | undefined {
  const expected = REPORT_FOR_TEST[test];
  const candidates = reports.filter((report) => !!scopeFor(report, test));
  const score = (report: EvidenceReport): number => {
    const scoped = scopeFor(report, test);
    const missing = scoped ? requiredFieldsForCoverage(scoped.coverage, config, test) : ['测试项目范围未定义'];
    let value = report.status === 'ready' && report.verified ? 100 : 0;
    // A fully matching replacement scope must win over the expected legacy
    // report, even when the latter has a familiar report ID but no longer
    // covers a changed driver/material/parameter.
    if (missing.length === 0) value += 1000;
    if (report.id === expected) value += 5;
    if (report.testScopes?.[test]) value += 2;
    return value;
  };
  return candidates.sort((a, b) => score(b) - score(a) || a.id.localeCompare(b.id))[0];
}

function requiredFields(report: EvidenceReport, config: ProductConfig, test: string): string[] {
  const scoped = scopeFor(report, test);
  return scoped ? requiredFieldsForCoverage(scoped.coverage, config, test) : ['测试项目范围未定义'];
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
  const findings: Finding[] = [];
  const requiredTests: string[] = [];
  const reusedTests: string[] = [];
  const warnings: string[] = ['费用、周期与报告均为合成演示数据，最终以检测机构意见和实验室排期为准。'];

  const changedPower = config.powerW !== base.powerW;
  const changedIp = !sameValue(normIp(config.ip), normIp(base.ip));
  const changedDriver = !sameValue(config.driver, base.driver);
  const changedMaterial = !sameValue(config.material, base.material);
  const changedMarket = !sameValue(config.market, base.market);
  const changedModel = !sameValue(config.model, base.model);

  const tests = ['temperature', 'ip', 'emc', 'rohs', 'electrical-strength'];
  for (const test of tests) {
    const report = findReport(reports, test, config);
    const scope = scopeFor(report, test);
    const coverage = scope?.coverage;
    const title = TEST_TITLES[test];
    const reportReady = !!report && report.status === 'ready' && report.verified;
    const missing = report ? requiredFields(report, config, test) : ['报告'];
    const definitionGap = missing.some((item) => item.includes('未定义') || item.includes('当前值缺失')) || scopePageMissing(report, test);
    let status: Finding['status'] = 'reuse';
    let reason = '证据报告已验证，当前配置在该测试项目的覆盖条件内。';

    if (!reportReady) {
      status = 'review';
      reason = report ? '报告缺失、未验证或状态不可用，必须人工核验，不能自动放行。' : '缺少该测试项目的证据报告，必须人工核验。';
    } else if (scopePageMissing(report, test)) {
      status = 'review';
      reason = '报告声明的测试项目页码不存在，证据引用无效，必须人工核验。';
    } else if (definitionGap) {
      status = 'review';
      reason = `证据覆盖条件不完整：${missing.join('、')}；必须人工核验，不能自动放行。`;
    } else if (test === 'temperature') {
      if (config.powerW === null) {
        status = 'review'; reason = '缺少当前功率，不能确认温升报告覆盖范围。';
      } else if (changedPower && coverage && (coverage.powerMinW !== null || coverage.powerMaxW !== null) && !inRange(config.powerW, coverage.powerMinW, coverage.powerMaxW)) {
        status = 'retest'; reason = '功率超出 TR-001 温升报告的 18W–30W 覆盖区间。';
      } else if (missing.length > 0) {
        status = 'retest'; reason = `温升报告不覆盖：${missing.join('、')}。`;
      }
    } else if (test === 'ip') {
      if (!config.ip) {
        status = 'review'; reason = '缺少当前防护等级，不能确认防尘防水报告覆盖范围。';
      } else if (changedIp && (missing.length > 0 || !coverage?.ipLevels.some((level) => sameValue(level, config.ip)))) {
        status = 'retest'; reason = '防护等级变化，TR-001 未覆盖新的 IP 等级。';
      } else if (missing.length > 0) {
        status = 'retest'; reason = `防护测试报告不覆盖：${missing.join('、')}。`;
      }
    } else if (test === 'emc') {
      if (changedDriver && missing.length === 0) { status = 'reuse'; reason = '新的已验证 EMC 证据覆盖当前驱动、功率、材料和市场条件，可沿用。'; }
      else if (changedDriver) { status = 'retest'; reason = '驱动电源变化，现有 EMC 覆盖条件不匹配，需要重新测试。'; }
      else if (missing.length > 0) { status = 'review'; reason = `EMC 独立覆盖条件未满足：${missing.join('、')}；不能只因驱动相同就沿用。`; }
    } else if (test === 'rohs') {
      if (changedMaterial && missing.length === 0) { status = 'reuse'; reason = '新的已验证材料证据覆盖当前材料组合，可沿用。'; }
      else if (changedMaterial) { status = 'retest'; reason = '材料组合变化，现有 RoHS / REACH 覆盖条件不匹配，需要重新核对。'; }
      else if (missing.length > 0) { status = 'review'; reason = `RoHS 材料证据不覆盖：${missing.join('、')}。`; }
    } else if (test === 'electrical-strength') {
      if (changedDriver && missing.length === 0) { status = 'reuse'; reason = '新的已验证电气安全证据覆盖当前驱动条件，可沿用。'; }
      else if (changedDriver) { status = 'retest'; reason = '驱动电源变化，现有电气安全覆盖条件不匹配，需要复核。'; }
      else if (missing.includes('功率范围不匹配')) { status = 'retest'; reason = '功率超出电气强度报告的覆盖区间，需要复核。'; }
      else if (missing.length > 0) { status = 'review'; reason = `电气强度证据不覆盖：${missing.join('、')}。`; }
    }

    if (status === 'retest' && !testCost(test, costs)) {
      status = 'review';
      reason = `${title}需要补测，但缺少对应费用与周期数据，必须人工核验。`;
    }

    const finding = createFinding(`finding-${test}`, test, title, 'compliance', status, reason, TEST_RULES[test], report, test, costs);
    findings.push(finding);
    if (status === 'retest') requiredTests.push(test);
    if (status === 'reuse') reusedTests.push(test);
  }

  if (isChanged(config, base)) {
    const documentCost = testCost('document-update', costs);
    for (const doc of DOCUMENTS) {
      const report = reports.find((item) => item.id === doc.reportId);
      const documentEvidenceReady = !!report && report.status === 'ready' && report.verified && report.pages.length > 0;
      const documentStatus: Finding['status'] = documentCost && documentEvidenceReady ? 'update' : 'review';
      findings.push({
        id: `finding-${doc.id}`, itemId: doc.id, title: doc.title, category: 'documents', status: documentStatus,
        reason: !documentEvidenceReady
          ? `${doc.reason} 当前文件证据缺失或未验证，需要创建/补齐并人工确认。`
          : documentCost ? doc.reason : `${doc.reason} 但缺少文档更新费用与周期数据，必须人工核验。`,
        ruleIds: [doc.rule], evidence: evidenceFor(report), feeEur: null, days: documentCost?.days ?? null,
      });
    }
  }

  const hasDeliveryCommitment = /(原交期|按原交期|保证(?:交期|合规|认证)|承诺(?:交期|合规|认证)|guarantee|guaranteed|same delivery|deliver on time)/i.test(commitment);
  const withholdLanguage = /(暂不承诺|不承诺|不要承诺|排期确认后|待.*确认|do not commit|without committing)/i.test(commitment);
  const hasRetestOrReview = findings.some((finding) => finding.status === 'retest' || finding.status === 'review');
  if (hasDeliveryCommitment && hasRetestOrReview && !withholdLanguage) {
    findings.push({
      id: 'finding-contract-delivery', itemId: 'contract-delivery', title: '交期承诺风险', category: 'contract', status: 'warning',
      reason: '补测或排期仍未确认，不应承诺原交期；建议改为“测试排期确认后告知”。', ruleIds: ['R-CONTRACT-001'], evidence: [], feeEur: null, days: null,
    });
    warnings.push('检测排期尚未确认，报价回复不得承诺原交期。');
  }
  if (withholdLanguage) warnings.push('已记录暂不承诺具体交期，回复应等待实验室排期确认。');

  const uniqueRetests = [...new Set(requiredTests)];
  const uniqueDocs = [...new Set(findings.filter((finding) => finding.category === 'documents').map((finding) => finding.itemId))];
  const testCostItems = uniqueRetests.map((id) => testCost(id, costs)).filter((item): item is CostItem => !!item);
  const totalCostEur = testCostItems.reduce((sum, item) => sum + item.feeEur, 0);
  const parallelDays = testCostItems.length > 0 ? Math.max(...testCostItems.map((item) => item.days)) : 0;
  const documentationDays = uniqueDocs.length > 0 ? (testCost('document-update', costs)?.days ?? 2) : 0;
  const reviewCount = findings.filter((finding) => finding.status === 'review').length;
  const leadTimeDays = reviewCount > 0 ? null : (parallelDays + documentationDays || 0);
  const confidence = reviewCount > 0 ? Math.max(0.55, 0.9 - reviewCount * 0.1) : (hasRetestOrReview ? 0.93 : 0.98);
  const canQuote = reviewCount === 0;

  const resultWithoutAlternatives: AnalysisResult = {
    id: '', ruleVersion: RULE_VERSION, config: { ...config }, findings, requiredTests: uniqueRetests,
    reusedTests: [...new Set(reusedTests)], documentUpdates: uniqueDocs, reviewCount, totalCostEur,
    leadTimeDays, canQuote, confidence, warnings, alternatives: [],
    calculation: { parallelDays, documentationDays, formula: `max(${testCostItems.length ? testCostItems.map((item) => item.days).join(',') : 0}) + ${documentationDays} = ${leadTimeDays ?? '待人工核验'} 个工作日` },
  };

  const fingerprintInput = {
    ruleVersion: RULE_VERSION, config, base, commitment, costs,
    reports: reports.map((report) => ({ id: report.id, status: report.status, verified: report.verified, coverage: report.coverage, testScopes: report.testScopes, pages: report.pages })),
    findings, requiredTests: uniqueRetests, documentUpdates: uniqueDocs,
  };
  resultWithoutAlternatives.id = `analysis-${hashId(fingerprintInput)}`;

  if (includeAlternatives) {
    const alternativeA: ProductConfig = { ...config, powerW: 30, ip: 'IP44' };
    const alternativeB: ProductConfig = { ...config, powerW: config.powerW === null || config.powerW < 36 ? 36 : config.powerW, ip: config.ip ?? 'IP44' };
    const buildAlternative = (id: 'A' | 'B', alternativeConfig: ProductConfig): Alternative => {
      const alternative = analyzeCore(alternativeConfig, reports, { ...options, baseConfig: base, includeAlternatives: false }, false);
      const quoteSummary = alternative.leadTimeDays === null ? '存在待人工核验项，无法自动承诺交期。' : `预计 ${alternative.leadTimeDays} 个工作日，费用 €${alternative.totalCostEur.toLocaleString('en-US')}（示意）。`;
      return {
        id, label: `方案 ${id}`, config: alternativeConfig, totalCostEur: alternative.totalCostEur,
        leadTimeDays: alternative.leadTimeDays, requiredTests: alternative.requiredTests,
        summary: `${quoteSummary} ${alternative.requiredTests.map((test) => TEST_TITLES[test]).join('、') || '无需新增测试'}。`,
      };
    };
    resultWithoutAlternatives.alternatives = [buildAlternative('A', alternativeA), buildAlternative('B', alternativeB)];
  }
  return resultWithoutAlternatives;
}

export function analyzeChange(config: ProductConfig, reports: EvidenceReport[] = seedReports, options: AnalyzeOptions = {}): AnalysisResult {
  return analyzeCore({ ...config, ip: normIp(config.ip) }, reports, options, options.includeAlternatives !== false);
}

function extractLast(text: string, regex: RegExp): string | null {
  const matches = [...text.matchAll(regex)];
  const valid = matches.filter((match) => {
    const before = text.slice(Math.max(0, (match.index ?? 0) - 5), match.index ?? 0);
    return !/(不需要|不用|不要|not need|without)\s*$/i.test(before);
  });
  return valid.at(-1)?.[1] ?? null;
}

export function parseLocalChange(message: string, current: ProductConfig, previous: AnalysisResult | null = null): { config: ProductConfig; withholdDelivery: boolean; summary: string } {
  const text = message.trim();
  const optionA = /(?:方案|option)\s*A\b|选(?:择)?\s*A\b|choose\s*A/i.test(text);
  const optionB = /(?:方案|option)\s*B\b|选(?:择)?\s*B\b|choose\s*B/i.test(text);
  let config: ProductConfig = { ...current };
  let summary = '';
  if (optionA || optionB) {
    const selected = previous?.alternatives.find((alternative) => alternative.id === (optionA ? 'A' : 'B'));
    if (selected) config = { ...selected.config };
    else if (optionA) config = { ...config, powerW: 30, ip: 'IP44' };
    else config = { ...config, powerW: 36, ip: 'IP44' };
    summary = `已选择方案 ${optionA ? 'A' : 'B'}，将按新配置重新推演。`;
  }
  const power = extractLast(text, /(\d+(?:\.\d+)?)\s*(?:W|瓦)\b/gi);
  const ip = extractLast(text, /(IP\s*\d{2})\b/gi);
  const driver = extractLast(text, /(DRV[-\s]?[A-Z0-9]+)/gi);
  const market = /(?:德国|德国产品|germany|german|deutsch)/i.test(text) ? 'DE' : null;
  const materialMatch = text.match(/(?:材料|材质|material)\s*(?:改为|变更为|换成|to|=|:)?\s*([A-Za-z][A-Za-z0-9 _-]{2,30})/i);
  if (power) config.powerW = Number(power);
  if (ip) config.ip = normIp(ip);
  if (driver) config.driver = driver.toUpperCase().replace(/\s+/g, '');
  if (market) config.market = market;
  if (materialMatch?.[1]) config.material = materialMatch[1].trim().replace(/[，。,.;；].*$/, '');
  const withholdDelivery = /(暂不承诺|不承诺|不要承诺|排期确认后|待.*确认|do not commit|without committing)/i.test(text);
  if (withholdDelivery) summary += `${summary ? ' ' : ''}已标记暂不承诺具体交期。`;
  if (!power && !ip && !driver && !market && !materialMatch && !optionA && !optionB && !withholdDelivery) summary = '未识别到可安全应用的配置变更，保留当前配置并建议人工核验。';
  return { config, withholdDelivery, summary: summary || '已识别变更，等待确定性规则重新计算。' };
}

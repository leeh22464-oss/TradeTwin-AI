import { describe, expect, it } from 'vitest';
import type { EvidenceReport, ProductConfig } from '../shared/types';
import { analyzeChange, parseLocalChange } from '../server/engine';
import { BASE_CONFIG, RULE_VERSION, seedCosts, seedReports } from '../server/seed';

const config = (patch: Partial<ProductConfig> = {}): ProductConfig => ({ ...BASE_CONFIG, ...patch });

describe('deterministic coverage and minimum retest engine', () => {
  it('returns the baseline as reusable with no documentation churn', () => {
    const result = analyzeChange(config());
    expect(result.requiredTests).toEqual([]);
    expect(result.reusedTests).toContain('temperature');
    expect(result.documentUpdates).toEqual([]);
    expect(result.totalCostEur).toBe(0);
    expect(result.leadTimeDays).toBe(0);
    expect(result.reviewCount).toBe(0);
    expect(result.canQuote).toBe(true);
  });

  it('detects 36W/IP44 as the two required retests and calculates parallel then serial days', () => {
    const result = analyzeChange(config({ powerW: 36, ip: 'IP44' }));
    expect(result.requiredTests).toEqual(['temperature', 'ip']);
    expect(result.totalCostEur).toBe(2100);
    expect(result.leadTimeDays).toBe(8);
    expect(result.calculation.formula).toContain('max(6,5) + 2 = 8');
    expect(result.findings.find((item) => item.itemId === 'temperature')?.status).toBe('retest');
    expect(result.findings.find((item) => item.itemId === 'ip')?.status).toBe('retest');
    expect(result.findings.filter((item) => item.status === 'update')).toHaveLength(3);
  });

  it('keeps EMC reusable for 36W only because its independent report covers the changed power and driver', () => {
    const result = analyzeChange(config({ powerW: 36, ip: 'IP44' }));
    expect(result.reusedTests).toContain('emc');
    expect(result.findings.find((item) => item.itemId === 'emc')?.evidence[0]).toMatchObject({ reportId: 'TR-002', page: 1 });
  });

  it('calculates option A (30W/IP44) as IP retest plus document update', () => {
    const result = analyzeChange(config({ powerW: 36, ip: 'IP44' }));
    const optionA = result.alternatives.find((item) => item.id === 'A');
    expect(optionA).toMatchObject({ totalCostEur: 900, leadTimeDays: 7, requiredTests: ['ip'] });
  });

  it('does not turn an in-range 28W change into a retest', () => {
    const result = analyzeChange(config({ powerW: 28 }));
    expect(result.requiredTests).toEqual([]);
    expect(result.totalCostEur).toBe(0);
    expect(result.leadTimeDays).toBe(2);
    expect(result.documentUpdates).toEqual(['doc', 'label', 'manual']);
    expect(result.findings.filter((item) => item.category === 'documents').map((item) => item.itemId)).toEqual(['doc', 'label', 'manual']);
  });

  it('treats IP44 as a gap even when power remains 30W', () => {
    const result = analyzeChange(config({ powerW: 30, ip: 'IP44' }));
    expect(result.requiredTests).toEqual(['ip']);
    expect(result.totalCostEur).toBe(900);
    expect(result.leadTimeDays).toBe(7);
  });

  it('retests every declared scope plus EMC and electrical strength when the driver changes', () => {
    const result = analyzeChange(config({ driver: 'DRV-B' }));
    expect(result.requiredTests).toEqual(['temperature', 'ip', 'emc', 'electrical-strength']);
    expect(result.totalCostEur).toBe(3600);
    expect(result.leadTimeDays).toBe(9);
  });

  it('does not reuse EMC from the same driver when another independent condition is missing', () => {
    const reports = seedReports.map((report) => report.id === 'TR-002'
      ? { ...report, coverage: { ...report.coverage, materials: ['different-material'] }, testScopes: { emc: { ...report.testScopes!.emc, coverage: { ...report.testScopes!.emc.coverage, materials: ['different-material'] } } } }
      : report);
    const result = analyzeChange(config(), reports);
    const emc = result.findings.find((item) => item.itemId === 'emc');
    expect(emc?.status).toBe('review');
    expect(emc?.reason).toContain('不能只因驱动相同');
    expect(result.canQuote).toBe(false);
  });

  it('routes a material change to RoHS retest and EMC review when the report no longer matches material', () => {
    const result = analyzeChange(config({ material: 'aluminium-v2' }));
    expect(result.requiredTests).toContain('rohs');
    expect(result.findings.find((item) => item.itemId === 'rohs')?.status).toBe('retest');
    expect(result.findings.find((item) => item.itemId === 'emc')?.status).toBe('review');
    expect(result.findings.find((item) => item.itemId === 'temperature')?.status).toBe('retest');
  });

  it('does not reuse electrical-strength evidence for IP65 outside its declared IP scope', () => {
    const result = analyzeChange(config({ ip: 'IP65' }));
    expect(result.findings.find((item) => item.itemId === 'electrical-strength')?.status).toBe('review');
    expect(result.canQuote).toBe(false);
  });

  it('routes an unknown model to review instead of defaulting it to NL-L', () => {
    const result = analyzeChange(config({ model: 'UNKNOWN-7' }));
    expect(result.reviewCount).toBeGreaterThan(0);
    expect(result.canQuote).toBe(false);
    expect(result.warnings[0]).toContain('合成演示数据');
  });

  it('routes a missing power value to review when the report needs a power range', () => {
    const result = analyzeChange(config({ powerW: null }));
    expect(result.findings.find((item) => item.itemId === 'temperature')?.status).toBe('review');
    expect(result.leadTimeDays).toBeNull();
  });

  it('routes an unverified report to manual review', () => {
    const reports = seedReports.map((report) => report.id === 'TR-001' ? { ...report, verified: false } : report);
    const result = analyzeChange(config({ powerW: 36, ip: 'IP44' }), reports);
    expect(result.findings.filter((item) => ['temperature', 'ip', 'electrical-strength'].includes(item.itemId)).every((item) => item.status === 'review')).toBe(true);
    expect(result.canQuote).toBe(false);
  });

  it('handles a missing report without silently passing it', () => {
    const reports = seedReports.filter((report) => report.id !== 'TR-002');
    const result = analyzeChange(config());
    const missing = analyzeChange(config(), reports);
    expect(missing.findings.find((item) => item.itemId === 'emc')?.status).toBe('review');
    expect(missing.reviewCount).toBeGreaterThan(result.reviewCount);
  });

  it('uses evidence page and quote references in every technical finding', () => {
    const result = analyzeChange(config({ powerW: 36, ip: 'IP44' }));
    for (const finding of result.findings.filter((item) => item.category === 'compliance')) {
      expect(finding.evidence.length).toBeGreaterThan(0);
      expect(finding.evidence[0].reportId).toMatch(/^TR-/);
      expect(finding.evidence[0].quote.trim().length).toBeGreaterThan(0);
      const report = seedReports.find((item) => item.id === finding.evidence[0].reportId);
      const source = report?.pages.find((item) => item.page === finding.evidence[0].page);
      expect(source?.text.includes(finding.evidence[0].quote)).toBe(true);
    }
  });

  it('adds a conservative warning for an original-delivery commitment', () => {
    const result = analyzeChange(config({ powerW: 36, ip: 'IP44' }), seedReports, { commitment: '按原交期保证交付' });
    expect(result.findings.find((item) => item.itemId === 'contract-delivery')?.status).toBe('warning');
    expect(result.warnings.some((warning) => warning.includes('不得承诺原交期'))).toBe(true);
  });

  it('does not add the warning after the user explicitly withholds delivery commitment', () => {
    const result = analyzeChange(config({ powerW: 36, ip: 'IP44' }), seedReports, { commitment: '暂不承诺具体交期，测试排期确认后告知' });
    expect(result.findings.some((item) => item.itemId === 'contract-delivery')).toBe(false);
    expect(result.warnings.some((warning) => warning.includes('暂不承诺'))).toBe(true);
  });

  it('deduplicates test costs even when multiple findings point to the same test item', () => {
    const duplicateCosts = [...seedCosts, { ...seedCosts.find((item) => item.id === 'ip')!, title: 'duplicate ip', feeEur: 900, days: 5 }];
    const result = analyzeChange(config({ powerW: 36, ip: 'IP44' }), seedReports, { costs: duplicateCosts });
    expect(result.totalCostEur).toBe(2100);
  });

  it('is idempotent for identical input, including the analysis fingerprint', () => {
    const first = analyzeChange(config({ powerW: 36, ip: 'IP44' }));
    const second = analyzeChange(config({ powerW: 36, ip: 'IP44' }));
    expect(second).toEqual(first);
  });

  it('changes the fingerprint when a report page or verification state changes', () => {
    const first = analyzeChange(config({ powerW: 36, ip: 'IP44' }));
    const reports = seedReports.map((report) => report.id === 'TR-001' ? { ...report, pages: [...report.pages, { page: 99, text: 'manual review note' }] } : report);
    const second = analyzeChange(config({ powerW: 36, ip: 'IP44' }), reports);
    expect(second.id).not.toBe(first.id);
  });

  it('parses English and Chinese changes and delivery withholding', () => {
    const parsed = parseLocalChange('Buyer changes to 36W and IP44; 暂不承诺交期', BASE_CONFIG);
    expect(parsed.config).toMatchObject({ powerW: 36, ip: 'IP44', market: 'DE' });
    expect(parsed.withholdDelivery).toBe(true);
  });

  it('parses German market and driver changes', () => {
    const parsed = parseLocalChange('Der deutsche Käufer benötigt 28W, IP20 und DRV-B.', BASE_CONFIG);
    expect(parsed.config).toMatchObject({ powerW: 28, ip: 'IP20', driver: 'DRV-B', market: 'DE' });
  });

  it('selects alternative A without extracting the negative 36W phrase', () => {
    const previous = analyzeChange(config({ powerW: 36, ip: 'IP44' }));
    const parsed = parseLocalChange('不需要 36W，选方案 A，先不要承诺交期', previous.config, previous);
    expect(parsed.config.powerW).toBe(30);
    expect(parsed.config.ip).toBe('IP44');
    expect(parsed.withholdDelivery).toBe(true);
  });

  it('selects alternative B from a prior analysis', () => {
    const previous = analyzeChange(config({ powerW: 30, ip: 'IP44' }));
    const parsed = parseLocalChange('客户选择 option B', previous.config, previous);
    expect(parsed.config.powerW).toBe(36);
    expect(parsed.config.ip).toBe('IP44');
  });

  it('returns an explicit no-op summary for unrelated text', () => {
    const parsed = parseLocalChange('谢谢，请先整理文件。', BASE_CONFIG);
    expect(parsed.config).toEqual(BASE_CONFIG);
    expect(parsed.summary).toContain('未识别');
  });

  it('uses the declared version in every result and finding rules', () => {
    const result = analyzeChange(BASE_CONFIG);
    expect(result.ruleVersion).toBe(RULE_VERSION);
    expect(result.findings.flatMap((item) => item.ruleIds).length).toBeGreaterThan(0);
    expect(result.findings.every((item) => item.ruleIds.length > 0)).toBe(true);
  });

  it('does not silently use an aggregate report when the requested test is not present', () => {
    const reports = seedReports.map((report) => report.id === 'TR-002' ? { ...report, coverage: { ...report.coverage, tests: [] }, testScopes: {} } : report);
    const result = analyzeChange(BASE_CONFIG, reports);
    expect(result.findings.find((item) => item.itemId === 'emc')?.status).toBe('review');
    expect(result.canQuote).toBe(false);
  });

  it('requires per-test scopes when a report aggregates multiple tests', () => {
    const reports = seedReports.map((report) => report.id === 'TR-002'
      ? { ...report, coverage: { ...report.coverage, tests: ['emc', 'temperature'] }, testScopes: undefined }
      : report);
    const result = analyzeChange(BASE_CONFIG, reports);
    const emc = result.findings.find((item) => item.itemId === 'emc');
    expect(emc?.status).toBe('review');
    expect(emc?.evidence).toEqual([]);
    expect(emc?.reason).toContain('缺少该测试项目的证据报告');
    expect(result.canQuote).toBe(false);
  });

  it('uses a confirmed single-test report-level scope and cites a real text page', () => {
    const reports = seedReports.map((report) => report.id === 'TR-002' ? { ...report, testScopes: undefined } : report);
    const result = analyzeChange(BASE_CONFIG, reports);
    const emc = result.findings.find((item) => item.itemId === 'emc');
    expect(emc?.status).toBe('reuse');
    expect(emc?.evidence[0]).toMatchObject({ reportId: 'TR-002', page: 1 });
    expect(emc?.evidence[0].quote).toBe(seedReports.find((item) => item.id === 'TR-002')!.pages[0].text);
  });

  it('uses a new verified EMC report when it covers a changed driver', () => {
    const reports = seedReports.map((report) => report.id === 'TR-002'
      ? {
        ...report,
        coverage: { ...report.coverage, drivers: ['DRV-B'] },
        testScopes: { emc: { ...report.testScopes!.emc, coverage: { ...report.testScopes!.emc.coverage, drivers: ['DRV-B'] } } },
      }
      : report);
    const result = analyzeChange(config({ driver: 'DRV-B' }), reports);
    expect(result.findings.find((item) => item.itemId === 'emc')?.status).toBe('reuse');
    expect(result.findings.find((item) => item.itemId === 'emc')?.evidence[0]).toMatchObject({ reportId: 'TR-002', page: 1 });
  });

  it('selects a verified replacement report covering the changed driver and power range', () => {
    const source = seedReports.find((report) => report.id === 'TR-002')!;
    const replacementText = 'EMC 适用系列：NL-L；驱动电源 DRV-B；材料 original-material；功率 18W–40W。';
    const replacement: EvidenceReport = {
      ...source,
      id: 'TR-004', title: 'EMC 测试报告 TR-004（示意）',
      pages: [{ page: 1, text: replacementText }, ...source.pages.slice(1)],
      coverage: { ...source.coverage, drivers: ['DRV-B'] },
      testScopes: { emc: { ...source.testScopes!.emc, coverage: { ...source.testScopes!.emc.coverage, drivers: ['DRV-B'] }, quote: replacementText } },
    };
    const reports = [...seedReports, replacement];
    const result = analyzeChange(config({ powerW: 36, driver: 'DRV-B' }), reports);
    const emc = result.findings.find((item) => item.itemId === 'emc');
    expect(emc?.status).toBe('reuse');
    expect(emc?.evidence[0]).toMatchObject({ reportId: 'TR-004', page: 1, quote: replacementText });
  });

  it('selects matching replacement temperature evidence when its driver and material constraints change', () => {
    const source = seedReports.find((report) => report.id === 'TR-001')!;
    const replacementText = '温升功率范围：18W–30W；驱动电源 DRV-B；材料 aluminium-v2。';
    const replacement: EvidenceReport = {
      ...source,
      id: 'TR-005', title: '温升测试报告 TR-005（示意）',
      pages: [{ page: 1, text: replacementText }], pageCount: 1,
      coverage: { ...source.coverage, ipLevels: [], drivers: ['DRV-B'], materials: ['aluminium-v2'], tests: ['temperature'] },
      testScopes: { temperature: { ...source.testScopes!.temperature, coverage: { ...source.testScopes!.temperature.coverage, ipLevels: [], drivers: ['DRV-B'], materials: ['aluminium-v2'] }, page: 1, quote: replacementText } },
    };
    const reports = [...seedReports, replacement];
    const result = analyzeChange(config({ driver: 'DRV-B', material: 'aluminium-v2' }), reports);
    const temperature = result.findings.find((item) => item.itemId === 'temperature');
    expect(temperature?.status).toBe('reuse');
    expect(temperature?.evidence[0]).toMatchObject({ reportId: 'TR-005', page: 1, quote: replacementText });
  });

  it('requires manual review when a temperature scope omits its power range', () => {
    const reports = seedReports.map((report) => report.id === 'TR-001'
      ? { ...report, testScopes: { ...report.testScopes, temperature: { ...report.testScopes!.temperature, coverage: { ...report.testScopes!.temperature.coverage, powerMinW: null, powerMaxW: null } } } }
      : report);
    const result = analyzeChange(BASE_CONFIG, reports);
    expect(result.findings.find((item) => item.itemId === 'temperature')?.status).toBe('review');
    expect(result.canQuote).toBe(false);
  });

  it('does not treat null driver, material or market as a known change', () => {
    const result = analyzeChange(config({ driver: null, material: null, market: null }));
    expect(result.findings.find((item) => item.itemId === 'emc')?.status).toBe('review');
    expect(result.findings.find((item) => item.itemId === 'rohs')?.status).toBe('review');
    expect(result.reviewCount).toBeGreaterThan(0);
    expect(result.canQuote).toBe(false);
  });

  it('keeps electrical-strength evidence inside its explicit 18–40W scope', () => {
    const inScope = analyzeChange(config({ powerW: 40 }));
    const outOfScope = analyzeChange(config({ powerW: 41 }));
    expect(inScope.findings.find((item) => item.itemId === 'electrical-strength')?.status).toBe('reuse');
    expect(outOfScope.findings.find((item) => item.itemId === 'electrical-strength')?.status).toBe('retest');
  });

  it('routes an empty power to review for both power-dependent tests', () => {
    const result = analyzeChange(config({ powerW: null }));
    expect(result.findings.find((item) => item.itemId === 'temperature')?.status).toBe('review');
    expect(result.findings.find((item) => item.itemId === 'electrical-strength')?.status).toBe('review');
    expect(result.canQuote).toBe(false);
  });

  it('blocks an otherwise required retest when its fee row is missing', () => {
    const costs = seedCosts.filter((item) => item.id !== 'temperature');
    const result = analyzeChange(config({ powerW: 36, ip: 'IP44' }), seedReports, { costs });
    const finding = result.findings.find((item) => item.itemId === 'temperature');
    expect(finding?.status).toBe('review');
    expect(finding?.reason).toContain('缺少对应费用与周期');
    expect(result.canQuote).toBe(false);
  });

  it('keeps every evidence quote as a real substring of its referenced report page', () => {
    const result = analyzeChange(config({ powerW: 36, ip: 'IP44' }));
    for (const finding of result.findings) {
      for (const evidence of finding.evidence) {
        const report = seedReports.find((item) => item.id === evidence.reportId);
        const source = report?.pages.find((item) => item.page === evidence.page);
        expect(source, `${evidence.reportId} p.${evidence.page} exists`).toBeTruthy();
        expect(source!.text.includes(evidence.quote)).toBe(true);
      }
    }
  });

  it('moves a test to review when its declared evidence page does not exist', () => {
    const reports = seedReports.map((report) => report.id === 'TR-001'
      ? { ...report, testScopes: { ...report.testScopes, temperature: { ...report.testScopes!.temperature, page: 99 } } }
      : report);
    const result = analyzeChange(config({ powerW: 36, ip: 'IP44' }), reports);
    const finding = result.findings.find((item) => item.itemId === 'temperature');
    expect(finding?.status).toBe('review');
    expect(finding?.evidence).toEqual([]);
    expect(result.canQuote).toBe(false);
  });

  it('falls back to real page text when a scope quote is not a page substring', () => {
    const reports = seedReports.map((report) => report.id === 'TR-002'
      ? { ...report, testScopes: { ...report.testScopes, emc: { ...report.testScopes!.emc, quote: 'invented quote' } } }
      : report);
    const result = analyzeChange(BASE_CONFIG, reports);
    const evidence = result.findings.find((item) => item.itemId === 'emc')?.evidence[0];
    expect(evidence?.page).toBe(1);
    expect(evidence?.quote).toBe(seedReports.find((item) => item.id === 'TR-002')!.pages[0].text);
  });

  it('treats missing document evidence as a manual review before quoting', () => {
    const reports = seedReports.filter((report) => report.id !== 'DOC-001');
    const result = analyzeChange(config({ powerW: 28 }), reports);
    const doc = result.findings.find((item) => item.title === 'DoC 更新');
    expect(doc?.status).toBe('review');
    expect(doc?.reason).toContain('创建/补齐');
    expect(result.canQuote).toBe(false);
  });
});

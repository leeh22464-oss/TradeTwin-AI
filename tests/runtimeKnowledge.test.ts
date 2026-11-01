import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { analyzeChange } from '../server/engine.js';
import { loadRuntimeKnowledge } from '../server/runtimeKnowledge.js';

const projectRoot = resolve(process.cwd());
const packageRoot = join(projectRoot, 'knowledge-base(2)');
const policyRoot = join(projectRoot, 'knowledge', 'runtime-profile.json');
const policyNotesRoot = join(projectRoot, 'knowledge', 'runtime-profile.md');
const temporaryRoots: string[] = [];

function copyFixture(): { packagePath: string; policyPath: string } {
  const root = mkdtempSync(join(tmpdir(), 'tradetwin-runtime-'));
  temporaryRoots.push(root);
  const packagePath = join(root, 'knowledge-base(2)');
  const policyPath = join(root, 'knowledge', 'runtime-profile.json');
  cpSync(packageRoot, packagePath, { recursive: true, force: true });
  mkdirSync(join(root, 'knowledge'), { recursive: true });
  cpSync(policyRoot, policyPath, { force: true });
  cpSync(policyNotesRoot, join(root, 'knowledge', 'runtime-profile.md'), { force: true });
  return { packagePath, policyPath };
}

afterEach(() => {
  while (temporaryRoots.length) rmSync(temporaryRoots.pop()!, { recursive: true, force: true });
});

describe('runtime knowledge profile', () => {
  it('loads the actual synthetic package with stable provenance and scoped evidence', () => {
    const first = loadRuntimeKnowledge();
    const second = loadRuntimeKnowledge();
    expect(first.available).toBe(true);
    expect(first).toEqual(second);
    expect(first.baseConfig).toEqual({
      model: 'NL-L24', powerW: 24, ip: 'IP20', driver: 'DRV-A', material: 'original-material', market: 'DE',
    });
    expect(first.context.profileId).toBe('tradetwin-runtime-kb-demo');
    expect(first.context.version).toBe('rules-2026.10.31-demo.v2+kb.0.2.0');
    expect(first.context.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(first.context.sources.map((source) => source.path)).toEqual([
      'knowledge/runtime-profile.json',
      'knowledge/runtime-profile.md',
      'knowledge-base(2)/synthetic-data/canonical-product.json',
      'knowledge-base(2)/synthetic-data/packs/baseline/02-product-spec.md',
      'knowledge-base(2)/synthetic-data/packs/baseline/03-declaration-of-conformity.md',
      'knowledge-base(2)/synthetic-data/packs/baseline/04-test-report.md',
      'knowledge-base(2)/synthetic-data/packs/baseline/05-label-and-instructions.md',
      'knowledge-base(2)/public-rules/rule-cards.jsonl',
    ]);
    expect(first.reports).toHaveLength(4);
    expect(first.reports.every((report) => report.source === 'synthetic' && report.verified && report.createdAt === '2026-10-31T00:00:00.000Z')).toBe(true);
    expect(first.reports.every((report) => report.coverage.series === 'NL-L24')).toBe(true);

    const testReport = first.reports.find((report) => report.id === 'TR-DEMO-NL-L24-01');
    expect(testReport).toBeDefined();
    expect(testReport!.knowledgeSource?.documentId).toBe('DOC-BASELINE-TEST-001');
    expect(testReport!.notes).toContain('演示预设确认状态，不代表真实工程/品质确认');
    expect(testReport!.pages.find((page) => page.page === 1)?.text).toContain('NL-L24');
    expect(testReport!.pages.find((page) => page.page === 2)?.text).toContain('18–30W');
    expect(testReport!.testScopes?.['electrical-strength']?.coverage.powerMaxW).toBe(30);
    expect(testReport!.testScopes?.['electrical-strength']?.coverage.powerMaxW).not.toBe(40);
    for (const scope of Object.values(testReport!.testScopes ?? {})) {
      const page = testReport!.pages.find((item) => item.page === scope.page);
      expect(page?.text).toContain(scope.quote!);
      expect(scope.page).toBe(2);
    }

    const combined = first.reports.filter((report) => report.knowledgeSource?.documentId === 'DOC-BASELINE-LABEL-001');
    expect(combined).toHaveLength(1);
    expect(combined[0].kind).toBe('label');
    expect(combined[0].coverage.tests).toEqual(['label', 'manual']);
    expect(combined[0].testScopes?.label?.page).toBe(1);
    expect(combined[0].testScopes?.manual?.page).toBe(2);

    const ruleIds = new Set(first.rules.map((rule) => rule.id));
    expect(first.rules.length).toBeGreaterThanOrEqual(14);
    for (const ids of Object.values(first.policy.ruleIds)) for (const id of ids) expect(ruleIds.has(id)).toBe(true);
    expect(first.costs.find((cost) => cost.id === 'driver-preparation')).toMatchObject({ feeEur: 0, days: 3, group: 'preparation' });
    expect(first.costs.find((cost) => cost.id === 'driver-preparation')?.knowledgeSource?.path).toBe('knowledge/runtime-profile.md');
    expect(first.warnings.join('\n')).toContain('synthetic_demo');
  });

  it('fingerprints a changed report boundary and changed policy fee', () => {
    const baseline = loadRuntimeKnowledge();
    const fixture = copyFixture();
    const reportPath = join(fixture.packagePath, 'synthetic-data/packs/baseline/04-test-report.md');
    writeFileSync(reportPath, readFileSync(reportPath, 'utf8').replace('18–30W', '18–40W'), 'utf8');
    const mismatchedReport = loadRuntimeKnowledge(fixture);
    expect(mismatchedReport.available).toBe(false);
    expect(mismatchedReport.warnings.join('\n')).toContain('功率范围来源不一致');

    const canonicalPath = join(fixture.packagePath, 'synthetic-data/canonical-product.json');
    writeFileSync(canonicalPath, readFileSync(canonicalPath, 'utf8').replace('"max": 30', '"max": 40'), 'utf8');
    const notesPath = join(fixture.policyPath, '..', 'runtime-profile.md');
    writeFileSync(notesPath, readFileSync(notesPath, 'utf8').replace(/18–30W/gu, '18–40W'), 'utf8');
    const changedReport = loadRuntimeKnowledge(fixture);
    expect(changedReport.available).toBe(true);
    expect(changedReport.context.fingerprint).not.toBe(baseline.context.fingerprint);
    expect(changedReport.reports.find((report) => report.id === 'TR-DEMO-NL-L24-01')?.testScopes?.temperature?.coverage.powerMaxW).toBe(40);

    const policy = JSON.parse(readFileSync(fixture.policyPath, 'utf8')) as { costs: Array<{ id: string; feeEur: number }> };
    policy.costs.find((cost) => cost.id === 'temperature')!.feeEur = 1234;
    writeFileSync(fixture.policyPath, `${JSON.stringify(policy, null, 2)}\n`, 'utf8');
    const changedPolicy = loadRuntimeKnowledge(fixture);
    expect(changedPolicy.available).toBe(true);
    expect(changedPolicy.context.fingerprint).not.toBe(changedReport.context.fingerprint);
    expect(changedPolicy.costs.find((cost) => cost.id === 'temperature')?.feeEur).toBe(1234);
  });

  it('does not broaden concrete NL-L24 evidence by prefix matching', () => {
    const profile = loadRuntimeKnowledge();
    expect(profile.baseConfig.model).toBe('NL-L24');
    for (const model of ['NL-L36', 'NL-L-OTHER']) {
      const result = analyzeChange(
        { ...profile.baseConfig, model },
        profile.reports,
        { baseConfig: profile.baseConfig, costs: profile.costs, policy: profile.policy, knowledgeContext: profile.context },
      );
      expect(result.reusedTests).not.toContain('temperature');
      expect(result.reusedTests).not.toContain('ip');
      expect(result.reusedTests).not.toContain('emc');
      expect(result.reusedTests).not.toContain('rohs');
      expect(result.reusedTests).not.toContain('electrical-strength');
      expect(result.findings.some((finding) => finding.status === 'review' || finding.status === 'retest')).toBe(true);
    }
    const legacyModel = analyzeChange(
      { ...profile.baseConfig, model: 'NL-L' },
      profile.reports,
      { baseConfig: profile.baseConfig, costs: profile.costs, policy: profile.policy, knowledgeContext: profile.context },
    );
    expect(legacyModel.findings.find((finding) => finding.itemId === 'temperature')?.status).toBe('reuse');
  });

  it('fails closed when the report identity no longer matches canonical source data', () => {
    const fixture = copyFixture();
    const reportPath = join(fixture.packagePath, 'synthetic-data/packs/baseline/04-test-report.md');
    writeFileSync(reportPath, readFileSync(reportPath, 'utf8').replace('TR-DEMO-NL-L24-01', 'TR-OTHER-001'), 'utf8');
    const profile = loadRuntimeKnowledge(fixture);
    expect(profile.available).toBe(false);
    expect(profile.warnings.join('\n')).toContain('报告编号');
  });

  it('fails closed when page-two coverage fields are missing or contradictory', () => {
    const fixture = copyFixture();
    const reportPath = join(fixture.packagePath, 'synthetic-data/packs/baseline/04-test-report.md');
    writeFileSync(reportPath, readFileSync(reportPath, 'utf8').replace('覆盖驱动电源：`DRV-A`', '覆盖驱动电源：`DRV-B`'), 'utf8');
    const profile = loadRuntimeKnowledge(fixture);
    expect(profile.available).toBe(false);
    expect(profile.warnings.join('\n')).toContain('驱动电源');

    const missingFixture = copyFixture();
    const missingReportPath = join(missingFixture.packagePath, 'synthetic-data/packs/baseline/04-test-report.md');
    writeFileSync(missingReportPath, readFileSync(missingReportPath, 'utf8').replace('覆盖防护等级：`IP20`', '防护等级字段待补录'), 'utf8');
    const missing = loadRuntimeKnowledge(missingFixture);
    expect(missing.available).toBe(false);
    expect(missing.warnings.join('\n')).toContain('防护等级');
  });

  it('fails closed when the specification model no longer matches canonical data', () => {
    const fixture = copyFixture();
    const specPath = join(fixture.packagePath, 'synthetic-data/packs/baseline/02-product-spec.md');
    writeFileSync(specPath, readFileSync(specPath, 'utf8').replace('型号 / SKU：`NL-L24`', '型号 / SKU：`NL-L99`'), 'utf8');
    const profile = loadRuntimeKnowledge(fixture);
    expect(profile.available).toBe(false);
    expect(profile.warnings.join('\n')).toContain('规格书 型号');
  });

  it('fails closed when an allowlisted source is missing', () => {
    const fixture = copyFixture();
    unlinkSync(join(fixture.packagePath, 'synthetic-data/packs/baseline/04-test-report.md'));
    const profile = loadRuntimeKnowledge(fixture);
    expect(profile.available).toBe(false);
    expect(profile.reports).toEqual([]);
    expect(profile.rules).toEqual([]);
    expect(profile.costs).toEqual([]);
    expect(profile.warnings.join('\n')).toMatch(/不可用|不存在|ENOENT/);
    expect(profile.reports.some((report) => report.verified)).toBe(false);
  });

  it('fails closed for a symlinked allowlisted file', () => {
    const fixture = copyFixture();
    const reportPath = join(fixture.packagePath, 'synthetic-data/packs/baseline/04-test-report.md');
    unlinkSync(reportPath);
    // A symlink is intentionally used only inside the isolated fixture.
    // The loader must never follow it into a file outside the package root.
    symlinkSync(join(packageRoot, 'synthetic-data/packs/baseline/04-test-report.md'), reportPath);
    const profile = loadRuntimeKnowledge(fixture);
    expect(profile.available).toBe(false);
    expect(profile.reports).toEqual([]);
  });

  it('keeps provenance paths resolvable for a temporary package', () => {
    const fixture = copyFixture();
    const profile = loadRuntimeKnowledge(fixture);
    expect(profile.available).toBe(true);
    for (const report of profile.reports) {
      expect(resolve(projectRoot, report.knowledgeSource!.path) === report.knowledgeSource!.path || report.knowledgeSource!.path.startsWith('/')).toBe(true);
      expect(readFileSync(report.knowledgeSource!.path, 'utf8')).toContain('document_id');
    }
    expect(profile.context.sources[0].path).toBe(fixture.policyPath);
    expect(profile.context.sources[1].path).toBe(join(fixture.policyPath, '..', 'runtime-profile.md'));
  });
});

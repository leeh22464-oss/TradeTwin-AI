import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { cp, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../server/index.js';
import type { CaseRecord, EvidenceReport } from '../shared/types.js';

describe('knowledge-backed inquiry to evidence and quote', () => {
  let directory: string;
  let packagePath: string;
  let policyPath: string;
  let server: Server;
  let app: ReturnType<typeof createApp>;
  let base: string;

  async function request(path: string, body?: unknown, method = 'POST'): Promise<any> {
    const response = await fetch(base + path, body === undefined ? undefined : {
      method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    const value = await response.json();
    expect(response.status, JSON.stringify(value)).toBeLessThan(300);
    return value;
  }
  const create = (body: Record<string, unknown>): Promise<CaseRecord> => request('/api/cases', { name: '合成 v2 回归', buyer: '隔离 QA', ...body });
  const analyze = (item: CaseRecord): Promise<CaseRecord> => request(`/api/cases/${item.id}/analyze`, { idempotencyKey: 'stable-client-request' });

  beforeAll(async () => {
    for (const name of ['OPENAI_API_KEY', 'OPENAI_MODEL', 'LLM_API_KEY', 'LLM_MODEL', 'LLM_BASE_URL', 'OBSIDIAN_VAULT_PATH']) vi.stubEnv(name, '');
    directory = await mkdtemp(join(tmpdir(), 'tradetwin-runtime-api-'));
    packagePath = join(directory, 'package');
    policyPath = join(directory, 'runtime-profile.json');
    await cp('knowledge-base(2)', packagePath, { recursive: true });
    await cp('knowledge/runtime-profile.json', policyPath);
    await cp('knowledge/runtime-profile.md', join(directory, 'runtime-profile.md'));
    app = createApp({ dataDir: join(directory, 'data'), knowledgePackagePath: packagePath, runtimePolicyPath: policyPath });
    server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    if (server) await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    app?.locals.db.close();
    if (directory) await rm(directory, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  it.each(['36 Watt statt 24 Watt', '36 W statt 24 W', '36W instead of the current 24W'])('prices the new value in %s without a model', async (inquiry) => {
    const item = await create({ inquiry });
    expect(item.baseConfig.model).toBe('NL-L24');
    expect(item.requestedConfig.powerW).toBe(36);
    const result = (await analyze(item)).analysis!;
    expect(result.requiredTests).toContain('temperature');
    expect(result.totalCostEur).toBeGreaterThanOrEqual(1200);
    expect(result.findings.find((f) => f.itemId === 'emc')?.status).toBe('review');
  });

  it('does not invent power or IP alternatives for 28W or unchanged requests', async () => {
    for (const config of [{ powerW: 28 }, {}]) {
      const result = (await analyze(await create({ config }))).analysis!;
      expect(result.alternatives).toEqual([]);
      expect(result.requiredTests).not.toContain('ip');
      expect(result.totalCostEur).toBe(0);
    }
  });

  it('retains IP65 and the requested power in the original-request option', async () => {
    const result = (await analyze(await create({ config: { powerW: 45, ip: 'IP65' } }))).analysis!;
    expect(result.alternatives.map((a) => [a.id, a.config.powerW, a.config.ip])).toEqual([
      ['A', 30, 'IP65'], ['B', 45, 'IP65'],
    ]);
  });

  it('chooses affirmative option B and preserves incidental materials and instruction languages', async () => {
    const initial = await analyze(await create({ config: { powerW: 36, ip: 'IP44' } }));
    const selected = await request(`/api/cases/${initial.id}/chat`, { message: 'Option A is too expensive, we take option B' });
    expect(selected.requestedConfig).toMatchObject({ powerW: 36, ip: 'IP44' });
    const material = await create({ inquiry: 'material to be confirmed later' });
    expect(material.requestedConfig.material).toBe(material.baseConfig.material);
    const french = await create({ config: { market: 'FR' } });
    const instructions = await request(`/api/cases/${french.id}/chat`, { message: 'Please update the German instructions' });
    expect(instructions.requestedConfig.market).toBe('FR');
  });

  it('uses canonical report pages and real RULE IDs, including the combined instructions document', async () => {
    const bootstrap = await request('/api/bootstrap');
    expect(bootstrap.runtimeKnowledge.available).toBe(true);
    const reports = bootstrap.reports as EvidenceReport[];
    expect(reports.some((r) => r.id === 'TR-DEMO-NL-L24-01')).toBe(true);
    expect(reports.some((r) => r.id === 'TR-001')).toBe(false);
    const ruleIds = new Set(bootstrap.rules.map((r: { id: string }) => r.id));
    const result = (await analyze(await create({ config: { powerW: 36, ip: 'IP44' } }))).analysis!;
    expect(result.knowledgeContext?.fingerprint).toBe(bootstrap.runtimeKnowledge.fingerprint);
    expect(result.findings.find((f) => f.itemId === 'temperature')?.reason).toContain('TR-DEMO-NL-L24-01');
    for (const finding of result.findings) {
      for (const id of finding.ruleIds) expect(ruleIds.has(id), id).toBe(true);
      for (const evidence of finding.evidence) {
        const report = reports.find((r) => r.id === evidence.reportId)!;
        expect(report.pages.find((p) => p.page === evidence.page)?.text).toContain(evidence.quote);
        const source = await (await fetch(`${base}/api/reports/${report.id}/file`)).text();
        expect(source).toContain(evidence.quote);
        expect(evidence.source?.path).toBe(report.knowledgeSource?.path);
      }
    }
    expect(result.findings.find((f) => f.itemId === 'manual')?.evidence[0]?.page).toBe(2);
  });

  it('includes three serial driver preparation days and keeps unconfirmed EMC separate', async () => {
    const same = (await analyze(await create({ config: { powerW: 36, ip: 'IP44' } }))).analysis!;
    expect(same.totalCostEur).toBe(2100);
    expect(same.calculation.estimatedDays).toBe(8);
    expect(same.canQuote).toBe(false);
    expect(same.leadTimeDays).toBeNull();
    const replaced = (await analyze(await create({ config: { powerW: 36, ip: 'IP44', driver: 'DRV-B' } }))).analysis!;
    expect(replaced.totalCostEur).toBe(3600);
    expect(replaced.calculation.preparationDays).toBe(3);
    expect(replaced.calculation.estimatedDays).toBe(12);
    expect(replaced.leadTimeDays).toBe(12);
  });

  it('holds an ambiguous inquiry until the user explicitly confirms the configuration', async () => {
    const item = await create({ inquiry: '24W or 36W' });
    const held = await analyze(item);
    expect(held.analysis?.canQuote).toBe(false);
    expect(held.analysis?.findings.some((f) => f.itemId === 'inquiry-ambiguity')).toBe(true);
    const blocked = await fetch(`${base}/api/cases/${item.id}/quote`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(blocked.status).toBe(409);
    const chat = await request(`/api/cases/${item.id}/chat`, { message: 'Please review the alternatives.' });
    expect(chat.quote).toBeNull();
    await request(`/api/cases/${item.id}`, { config: { ...item.baseConfig, powerW: 36 } }, 'PATCH');
    const confirmed = await analyze(item);
    expect(confirmed.analysis?.findings.some((f) => f.itemId === 'inquiry-ambiguity')).toBe(false);
  });

  it('invalidates cached analyses and quotes when the actual knowledge cost data changes', async () => {
    const item = await analyze(await create({ config: { powerW: 36, ip: 'IP44' } }));
    const quoted = await request(`/api/cases/${item.id}/quote`, {});
    expect(quoted.quote).not.toBeNull();
    const original = await readFile(policyPath, 'utf8');
    try {
      const policy = JSON.parse(original);
      policy.costs.find((c: { id: string }) => c.id === 'temperature').feeEur = 1300;
      await writeFile(policyPath, JSON.stringify(policy));
      expect((await request(`/api/cases/${item.id}`)).quote).toBeNull();
      const repriced = (await analyze(item)).analysis!;
      expect(repriced.totalCostEur).toBe(2200);
      expect(repriced.id).not.toBe(item.analysis?.id);
      expect(repriced.knowledgeContext?.fingerprint).not.toBe(item.analysis?.knowledgeContext?.fingerprint);
    } finally {
      await writeFile(policyPath, original);
      await request('/api/bootstrap');
    }
  });

  it('preserves manual report notes across profile reload and fails closed on missing source files', async () => {
    const bootstrap = await request('/api/bootstrap');
    const report = bootstrap.reports.find((r: EvidenceReport) => r.id === 'TR-DEMO-NL-L24-01');
    await request(`/api/reports/${report.id}`, { notes: '隔离工程师确认的限制，不能由同步覆盖。' }, 'PATCH');
    const path = join(packagePath, 'synthetic-data/packs/baseline/02-product-spec.md');
    await rename(path, path + '.unavailable');
    try {
      const unavailable = await request('/api/bootstrap');
      expect(unavailable.runtimeKnowledge.available).toBe(false);
      const result = (await analyze(await create({ config: { powerW: 36 } }))).analysis!;
      expect(result.canQuote).toBe(false);
      expect(result.reusedTests).toEqual([]);
    } finally {
      await rename(path + '.unavailable', path);
    }
    const restored = await request('/api/bootstrap');
    expect(restored.reports.find((r: EvidenceReport) => r.id === report.id).notes).toBe('隔离工程师确认的限制，不能由同步覆盖。');
    expect(restored.runtimeKnowledge.available).toBe(true);
  });
});

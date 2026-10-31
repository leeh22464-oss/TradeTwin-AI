import { createServer, type Server } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { CaseRecord, EvidenceReport } from '../shared/types.js';
import { AppDatabase } from '../server/db.js';
import { createApp } from '../server/index.js';
import { normalizeUploadedReportDisplay, parseUpload } from '../server/documents.js';

interface StartedApp {
  server: Server;
  baseUrl: string;
  close: () => Promise<void>;
}

async function startApp(dataDir: string): Promise<StartedApp> {
  const app = createApp({ dataDir, runtimeKnowledge: false });
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  return {
    server,
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: async () => {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      app.locals.db.close();
    },
  };
}

async function request(baseUrl: string, path: string, init?: RequestInit): Promise<{ response: Response; body: any }> {
  const response = await fetch(`${baseUrl}${path}`, init);
  const contentType = response.headers.get('content-type') || '';
  const body = contentType.includes('application/json') ? await response.json() : await response.text();
  return { response, body };
}

function jsonInit(method: string, body: unknown): RequestInit {
  return { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
}

async function startMockModel(): Promise<{ server: Server; baseUrl: string; calls: number }> {
  let calls = 0;
  const server = createServer((req, res) => {
    calls += 1;
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let system = '';
      try {
        const parsed = JSON.parse(body) as { messages?: Array<{ role?: string; content?: string }> };
        system = parsed.messages?.[0]?.content ?? '';
      } catch {
        // The adapter still receives a deterministic response for malformed
        // test payloads; the request count is what this fixture asserts.
      }
      const content = system.includes('Extract structured product changes')
        ? { config: { powerW: 30, ip: 'IP44' }, withholdDelivery: true, summary: 'mock model extraction' }
        : system.includes('Draft a bilingual business quote')
          ? { en: 'mock model English', de: 'mock model German', sales: ['mock sales'], quality: ['mock quality'], procurement: ['mock procurement'] }
          : { ok: true };
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }] }));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address() as AddressInfo;
  return { server, baseUrl: `http://127.0.0.1:${address.port}`, get calls() { return calls; } };
}

function makePdf(pageTexts: string[]): Buffer {
  const pageIds = pageTexts.map((_, index) => 3 + index);
  const contentIds = pageTexts.map((_, index) => 3 + pageTexts.length + index);
  const fontId = 3 + pageTexts.length * 2;
  const bodies = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pageTexts.length} >>`,
    ...pageTexts.map((_, index) => `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${fontId} 0 R >> >> /Contents ${contentIds[index]} 0 R >>`),
    ...pageTexts.map((page) => {
      const stream = page ? `BT /F1 12 Tf 72 720 Td (${page.replace(/[()\\]/g, '\\$&')}) Tj ET` : '';
      return `<< /Length ${Buffer.byteLength(stream, 'binary')} >>\nstream\n${stream}\nendstream`;
    }),
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let output = '%PDF-1.4\n';
  const offsets = [0];
  for (let index = 0; index < bodies.length; index += 1) {
    offsets.push(Buffer.byteLength(output, 'binary'));
    output += `${index + 1} 0 obj\n${bodies[index]}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(output, 'binary');
  output += `xref\n0 ${bodies.length + 1}\n0000000000 65535 f \n`;
  for (let index = 1; index < offsets.length; index += 1) output += `${String(offsets[index]).padStart(10, '0')} 00000 n \n`;
  output += `trailer\n<< /Size ${bodies.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(output, 'binary');
}

describe('TradeTwin API', () => {
  let dataDir: string;
  let started: StartedApp;
  const savedModelEnv = {
    openaiKey: process.env.OPENAI_API_KEY,
    openaiModel: process.env.OPENAI_MODEL,
    base: process.env.LLM_BASE_URL,
    key: process.env.LLM_API_KEY,
    model: process.env.LLM_MODEL,
    vault: process.env.OBSIDIAN_VAULT_PATH,
  };

  beforeAll(async () => {
    // API integration tests use local fixtures only. Prevent a developer's
    // dotenv credentials from turning ordinary case/chat tests into external
    // OpenAI calls.
    delete process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_MODEL;
    delete process.env.LLM_BASE_URL;
    delete process.env.LLM_API_KEY;
    delete process.env.LLM_MODEL;
    delete process.env.OBSIDIAN_VAULT_PATH;
    dataDir = await mkdtemp(join(tmpdir(), 'tradetwin-api-'));
    started = await startApp(dataDir);
  });

  afterAll(async () => {
    await started.close();
    await rm(dataDir, { recursive: true, force: true });
    if (savedModelEnv.openaiKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = savedModelEnv.openaiKey;
    if (savedModelEnv.openaiModel === undefined) delete process.env.OPENAI_MODEL; else process.env.OPENAI_MODEL = savedModelEnv.openaiModel;
    if (savedModelEnv.base === undefined) delete process.env.LLM_BASE_URL; else process.env.LLM_BASE_URL = savedModelEnv.base;
    if (savedModelEnv.key === undefined) delete process.env.LLM_API_KEY; else process.env.LLM_API_KEY = savedModelEnv.key;
    if (savedModelEnv.model === undefined) delete process.env.LLM_MODEL; else process.env.LLM_MODEL = savedModelEnv.model;
    if (savedModelEnv.vault === undefined) delete process.env.OBSIDIAN_VAULT_PATH; else process.env.OBSIDIAN_VAULT_PATH = savedModelEnv.vault;
  });

  it('returns health and seeded bootstrap data', async () => {
    const health = await request(started.baseUrl, '/api/health');
    expect(health.response.status).toBe(200);
    expect(health.body.ok).toBe(true);
    const bootstrap = await request(started.baseUrl, '/api/bootstrap');
    expect(bootstrap.response.status).toBe(200);
    expect(bootstrap.body.reports.length).toBeGreaterThanOrEqual(3);
    expect(bootstrap.body.costs.length).toBeGreaterThanOrEqual(4);
    expect(bootstrap.body.rules.length).toBeGreaterThanOrEqual(10);
    expect(bootstrap.body.model.mode).toBe('demo');
  });

  it('persists a case, performs deterministic analysis, and deduplicates analysis audit events', async () => {
    const created = await request(started.baseUrl, '/api/cases', jsonInit('POST', {
      name: '36W IP44 integration case', buyer: 'Test buyer',
      config: { powerW: 36, ip: 'IP44' }, commitment: '请先核对，暂不承诺具体交期',
    }));
    expect(created.response.status).toBe(201);
    const item = created.body as CaseRecord;
    const first = await request(started.baseUrl, `/api/cases/${item.id}/analyze`, jsonInit('POST', { idempotencyKey: 'integration-analysis' }));
    expect(first.response.status).toBe(200);
    expect(first.body.analysis.requiredTests).toContain('ip');
    expect(first.body.analysis.totalCostEur).toBeGreaterThan(0);
    expect(first.body.analysis.calculation.formula).toContain('max(');
    const auditBefore = await request(started.baseUrl, `/api/audit?caseId=${encodeURIComponent(item.id)}`);
    const second = await request(started.baseUrl, `/api/cases/${item.id}/analyze`, jsonInit('POST', { idempotencyKey: 'integration-analysis' }));
    const auditAfter = await request(started.baseUrl, `/api/audit?caseId=${encodeURIComponent(item.id)}`);
    expect(second.response.status).toBe(200);
    expect(second.body.updatedAt).toBe(first.body.updatedAt);
    expect(auditAfter.body.length).toBe(auditBefore.body.length);

    await started.close();
    started = await startApp(dataDir);
    const reopened = await request(started.baseUrl, `/api/cases/${item.id}`);
    expect(reopened.response.status).toBe(200);
    expect(reopened.body.analysis.id).toBe(first.body.analysis.id);
  });

  it('extracts Chinese and English inquiry configuration before the first analysis', async () => {
    const chineseInquiry = '请报价36W/IP44，暂不承诺具体交期。';
    const chinese = await request(started.baseUrl, '/api/cases', jsonInit('POST', {
      name: 'Chinese inquiry extraction', buyer: '中文买家', inquiry: chineseInquiry,
    }));
    expect(chinese.response.status).toBe(201);
    expect(chinese.body.requestedConfig.powerW).toBe(36);
    expect(chinese.body.requestedConfig.ip).toBe('IP44');
    expect(chinese.body.commitment).toContain('暂不承诺');
    expect(chinese.body.analysis).toBeNull();
    expect(chinese.body.messages[0]).toMatchObject({ role: 'user', content: chineseInquiry, mode: 'demo' });
    const chineseAudit = await request(started.baseUrl, `/api/audit?caseId=${encodeURIComponent(chinese.body.id)}`);
    const chineseCreated = chineseAudit.body.find((event: any) => event.type === 'case.created');
    const chineseDetail = JSON.parse(chineseCreated.detail);
    expect(chineseDetail.extraction.source).toBe('inquiry');
    expect(chineseDetail.extraction.mode).toBe('demo');
    expect(chineseDetail.extraction.retrievalIds).toEqual(expect.any(Array));
    const chineseAnalysis = await request(started.baseUrl, `/api/cases/${chinese.body.id}/analyze`, jsonInit('POST', {}));
    expect(chineseAnalysis.response.status).toBe(200);
    expect(chineseAnalysis.body.analysis.totalCostEur).toBe(2100);
    expect(chineseAnalysis.body.analysis.calculation.estimatedDays).toBe(8);
    expect(chineseAnalysis.body.analysis.leadTimeDays).toBeNull();
    expect(chineseAnalysis.body.analysis.findings.find((f: { itemId: string }) => f.itemId === 'emc').status).toBe('review');

    const englishInquiry = 'Please quote 36W / IP44 and do not commit to delivery.';
    const english = await request(started.baseUrl, '/api/cases', jsonInit('POST', {
      name: 'English inquiry extraction', buyer: 'English buyer', inquiry: englishInquiry,
    }));
    expect(english.response.status).toBe(201);
    expect(english.body.requestedConfig.powerW).toBe(36);
    expect(english.body.requestedConfig.ip).toBe('IP44');
    expect(english.body.commitment).toContain('暂不承诺');
    expect(english.body.analysis).toBeNull();
    expect(english.body.messages[0]).toMatchObject({ role: 'user', content: englishInquiry, mode: 'demo' });
    const englishAnalysis = await request(started.baseUrl, `/api/cases/${english.body.id}/analyze`, jsonInit('POST', {}));
    expect(englishAnalysis.response.status).toBe(200);
    expect(englishAnalysis.body.analysis.totalCostEur).toBe(2100);
    expect(englishAnalysis.body.analysis.calculation.estimatedDays).toBe(8);
    expect(englishAnalysis.body.analysis.leadTimeDays).toBeNull();
  });

  it('keeps explicit config authoritative over inquiry extraction', async () => {
    const inquiry = 'Please quote 36W / IP44 and do not commit to delivery.';
    const created = await request(started.baseUrl, '/api/cases', jsonInit('POST', {
      name: 'Explicit config precedence', buyer: 'Configured buyer',
      config: { powerW: 30, ip: 'IP20' }, inquiry,
    }));
    expect(created.response.status).toBe(201);
    expect(created.body.requestedConfig.powerW).toBe(30);
    expect(created.body.requestedConfig.ip).toBe('IP20');
    expect(created.body.commitment).toBe('');
    expect(created.body.messages[0]).toMatchObject({ role: 'user', content: inquiry, mode: 'explicit-config' });
    const audit = await request(started.baseUrl, `/api/audit?caseId=${encodeURIComponent(created.body.id)}`);
    const event = audit.body.find((item: any) => item.type === 'case.created');
    const detail = JSON.parse(event.detail);
    expect(detail.extraction.source).toBe('explicit-config');
    expect(detail.extraction.mode).toBe('explicit-config');
  });

  it('handles second-round option A chat, re-analysis, quote generation, and delivery hold', async () => {
    const bootstrap = await request(started.baseUrl, '/api/bootstrap');
    const existing = (bootstrap.body.cases as CaseRecord[]).find((item) => item.name === '36W IP44 integration case');
    expect(existing).toBeTruthy();
    const response = await request(started.baseUrl, `/api/cases/${existing!.id}/chat`, jsonInit('POST', {
      channel: 'rfq', message: '客户选择方案 A：改成 30W / IP44，请重新计算，不要承诺具体交期。',
    }));
    expect(response.response.status).toBe(200);
    expect(response.body.round).toBeGreaterThan(1);
    expect(response.body.requestedConfig.powerW).toBe(30);
    expect(response.body.requestedConfig.ip).toBe('IP44');
    expect(response.body.commitment).toContain('暂不承诺');
    expect(response.body.analysis.requiredTests).toContain('ip');
    expect(response.body.quote.channel).toBe('rfq');
    expect(response.body.quote.en).toMatch(/specific delivery commitment|pending/i);
    expect(response.body.messages.length).toBeGreaterThanOrEqual(2);
  });

  it('returns validation errors and 404s without leaking stacks', async () => {
    const missing = await request(started.baseUrl, '/api/cases/not-a-case');
    expect(missing.response.status).toBe(404);
    expect(missing.body.code).toBe('CASE_NOT_FOUND');
    expect(missing.body.stack).toBeUndefined();
    const badCase = await request(started.baseUrl, '/api/cases', jsonInit('POST', { quantity: 0 }));
    expect(badCase.response.status).toBe(400);
    expect(badCase.body.error).toMatch(/quantity/);
    const badInquiryType = await request(started.baseUrl, '/api/cases', jsonInit('POST', { inquiry: 36 }));
    expect(badInquiryType.response.status).toBe(400);
    expect(badInquiryType.body.error).toMatch(/inquiry/);
    const badInquiryLength = await request(started.baseUrl, '/api/cases', jsonInit('POST', { inquiry: 'x'.repeat(12_001) }));
    expect(badInquiryLength.response.status).toBe(400);
    expect(badInquiryLength.body.error).toMatch(/inquiry/);
    const badOverride = await request(started.baseUrl, '/api/cases/not-a-case/override', jsonInit('POST', {}));
    expect(badOverride.response.status).toBe(404);
  });

  it('uploads text, keeps source content, and requires valid coverage for verification', async () => {
    const form = new FormData();
    form.append('file', new Blob(['NL-L 18-30W IP20 DRV-A EMC RoHS Germany'], { type: 'text/plain' }), 'uploaded-report.txt');
    const uploaded = await request(started.baseUrl, '/api/reports', { method: 'POST', body: form });
    expect(uploaded.response.status).toBe(201);
    const report = uploaded.body as EvidenceReport;
    expect(report.source).toBe('uploaded');
    expect(report.verified).toBe(false);
    expect(report.coverage.tests.length).toBeGreaterThan(0);
    const source = await request(started.baseUrl, `/api/reports/${report.id}/file`);
    expect(source.response.status).toBe(200);
    expect(source.body).toContain('NL-L 18-30W IP20 DRV-A');
    const invalid = await request(started.baseUrl, `/api/reports/${report.id}`, jsonInit('PATCH', { verified: true, coverage: { tests: [] } }));
    expect(invalid.response.status).toBe(400);
    const verified = await request(started.baseUrl, `/api/reports/${report.id}`, jsonInit('PATCH', { verified: true, notes: '工程师已核对页码与原文。' }));
    expect(verified.response.status).toBe(200);
    expect(verified.body.verified).toBe(true);
    expect(verified.body.status).toBe('ready');
  });

  it('normalizes uploaded report filenames and keeps explicit titles and Unicode names', async () => {
    const mojibakeName = `${Buffer.from('中文报告', 'utf8').toString('latin1')}.txt`;
    const repairedFilename = await parseUpload({
      originalname: '中文报告.txt',
      mimetype: 'text/plain',
      buffer: Buffer.from('NL-L 24W IP20', 'utf8'),
    });
    expect(repairedFilename.report.filename).toBe('中文报告.txt');
    expect(repairedFilename.report.title).toBe('中文报告');

    const form = new FormData();
    form.append('file', new Blob(['中文报告 NL-L 24W IP20'], { type: 'text/plain' }), '中文报告.txt');
    const uploaded = await request(started.baseUrl, '/api/reports', { method: 'POST', body: form });
    expect(uploaded.response.status).toBe(201);
    expect(uploaded.body.filename).toBe('中文报告.txt');
    expect(uploaded.body.filenameEncoding).toBe('utf-8');
    const source = await request(started.baseUrl, `/api/reports/${uploaded.body.id}/file`);
    expect(source.response.status).toBe(200);
    expect(source.body).toContain('中文报告 NL-L 24W IP20');

    const literalNameForm = new FormData();
    literalNameForm.append('file', new Blob(['NL-L 24W IP20'], { type: 'text/plain' }), 'Â£.txt');
    const literalNameUpload = await request(started.baseUrl, '/api/reports', { method: 'POST', body: literalNameForm });
    expect(literalNameUpload.response.status).toBe(201);
    expect(literalNameUpload.body.filename).toBe('Â£.txt');
    expect(literalNameUpload.body.title).toBe('Â£');
    expect(literalNameUpload.body.filenameEncoding).toBe('utf-8');
    const bootstrapAfterLiteralName = await request(started.baseUrl, '/api/bootstrap');
    const displayedLiteralName = (bootstrapAfterLiteralName.body.reports as EvidenceReport[]).find((report) => report.id === literalNameUpload.body.id);
    expect(displayedLiteralName?.filename).toBe('Â£.txt');
    expect(displayedLiteralName?.title).toBe('Â£');

    const { filenameEncoding: _filenameEncoding, ...uploadedWithoutEncoding } = uploaded.body as EvidenceReport;
    const legacy = {
      ...uploadedWithoutEncoding,
      filename: mojibakeName,
      title: mojibakeName.slice(0, -4),
    };
    const repaired = normalizeUploadedReportDisplay(legacy);
    expect(repaired.filename).toBe('中文报告.txt');
    expect(repaired.title).toBe('中文报告');
    expect(legacy.filename).toBe(mojibakeName);
    expect(legacy.title).toBe(mojibakeName.slice(0, -4));
    const customTitle = normalizeUploadedReportDisplay({ ...legacy, title: '工程师自定义标题' });
    expect(customTitle.filename).toBe('中文报告.txt');
    expect(customTitle.title).toBe('工程师自定义标题');

    const explicitJson = await parseUpload({
      originalname: '中文报告.JSON',
      mimetype: 'application/json',
      buffer: Buffer.from(JSON.stringify({ title: '明确的 JSON 标题', pages: [{ page: 1, text: 'NL-L 24W' }] }), 'utf8'),
    });
    expect(explicitJson.report.filename).toBe('中文报告.JSON');
    expect(explicitJson.report.title).toBe('明确的 JSON 标题');

    for (const filename of ['Prüfbericht über Wärme.txt', '📄-报告.txt', 'café.txt']) {
      const healthy = await parseUpload({ originalname: filename, mimetype: 'text/plain', buffer: Buffer.from('NL-L 24W IP20', 'utf8') });
      expect(healthy.report.filename).toBe(filename);
      expect(healthy.report.title).toBe(filename.slice(0, -4));
    }
  });

  it('normalizes historical report metadata through DB reads without rewriting raw rows', async () => {
    const mojibakeStem = Buffer.from('中文报告', 'utf8').toString('latin1');
    const mojibakeName = `${mojibakeStem}.TXT`;
    const legacyDir = await mkdtemp(join(tmpdir(), 'tradetwin-legacy-report-'));
    let legacyDb: AppDatabase | null = null;
    let legacyApp: ReturnType<typeof createApp> | null = null;
    let legacyServer: Server | null = null;
    try {
      legacyDb = new AppDatabase({ dataDir: legacyDir });
      const seed = await parseUpload({ originalname: '历史报告.txt', mimetype: 'text/plain', buffer: Buffer.from('NL-L 24W IP20', 'utf8') });
      const { filenameEncoding: _seedFilenameEncoding, ...seedWithoutEncoding } = seed.report;
      const legacyReport = { ...seedWithoutEncoding, filename: mojibakeName, title: mojibakeName };
      legacyDb.saveReport(legacyReport, null);
      const rawBefore = legacyDb.sqlite.prepare('SELECT data_json, updated_at FROM reports WHERE id = ?').get(legacyReport.id) as { data_json: string; updated_at: string };

      const helperStem = normalizeUploadedReportDisplay({ ...legacyReport, title: mojibakeStem });
      expect(helperStem.filename).toBe('中文报告.TXT');
      expect(helperStem.title).toBe('中文报告');
      const helperLegacy = normalizeUploadedReportDisplay(legacyReport);
      expect(helperLegacy.filename).toBe('中文报告.TXT');
      expect(helperLegacy.title).toBe('中文报告');
      expect(normalizeUploadedReportDisplay({ ...legacyReport, title: '工程师自定义标题' }).title).toBe('工程师自定义标题');

      legacyApp = createApp({ dataDir: legacyDir, seed: false, runtimeKnowledge: false });
      legacyServer = createServer(legacyApp);
      await new Promise<void>((resolve, reject) => {
        legacyServer!.once('error', reject);
        legacyServer!.listen(0, '127.0.0.1', resolve);
      });
      const legacyAddress = legacyServer.address() as AddressInfo;
      const legacyBootstrap = await request(`http://127.0.0.1:${legacyAddress.port}`, '/api/bootstrap');
      const displayed = (legacyBootstrap.body.reports as EvidenceReport[]).find((report) => report.id === legacyReport.id);
      expect(displayed?.filename).toBe('中文报告.TXT');
      expect(displayed?.title).toBe('中文报告');
      const direct = legacyApp.locals.db.getReport(legacyReport.id);
      expect(direct?.report.filename).toBe('中文报告.TXT');
      const rawAfter = legacyDb.sqlite.prepare('SELECT data_json, updated_at FROM reports WHERE id = ?').get(legacyReport.id) as { data_json: string; updated_at: string };
      expect(rawAfter).toEqual(rawBefore);
    } finally {
      if (legacyServer?.listening) await new Promise<void>((resolve, reject) => legacyServer!.close((error) => error ? reject(error) : resolve()));
      legacyApp?.locals.db.close();
      legacyDb?.close();
      await rm(legacyDir, { recursive: true, force: true });
    }
  });

  it('records manual override, supports knowledge, export, and visible model fallback', async () => {
    const bootstrap = await request(started.baseUrl, '/api/bootstrap');
    const candidate = (bootstrap.body.cases as CaseRecord[])[0];
    expect(candidate).toBeTruthy();
    const analyzed = await request(started.baseUrl, `/api/cases/${candidate!.id}/analyze`, jsonInit('POST', {}));
    expect(analyzed.response.status).toBe(200);
    const item = analyzed.body as CaseRecord;
    const finding = item.analysis!.findings[0];
    const override = await request(started.baseUrl, `/api/cases/${item.id}/override`, jsonInit('POST', { findingId: finding.id, reason: '实验室已提供补充说明，保留原结论并记录人工依据。', actor: 'qa-test', decision: 'accept' }));
    expect(override.response.status).toBe(201);
    expect(override.body.actor).toBe('qa-test');
    const audit = await request(started.baseUrl, `/api/audit?caseId=${encodeURIComponent(item.id)}`);
    expect(audit.body.some((event: any) => event.type === 'finding.override')).toBe(true);
    const knowledge = await request(started.baseUrl, '/api/knowledge', jsonInit('POST', { title: '测试规则来源', content: '覆盖范围必须回到报告页码。', tags: ['test', 'evidence'] }));
    expect(knowledge.response.status).toBe(201);
    const search = await request(started.baseUrl, '/api/knowledge?q=页码');
    expect(search.body.some((entry: any) => entry.id === knowledge.body.id)).toBe(true);
    const vault = await request(started.baseUrl, '/api/knowledge/import-vault', { method: 'POST' });
    expect(vault.response.status).toBe(400);
    expect(vault.body.code).toBe('VAULT_UNAVAILABLE');
    const exported = await request(started.baseUrl, `/api/cases/${item.id}/export`);
    expect(exported.response.status).toBe(200);
    expect(exported.body).toContain('# TradeTwin AI 案件报告');
    const status = await request(started.baseUrl, '/api/model/status');
    expect(status.body.configured).toBe(false);
    expect(status.body.mode).toBe('demo');
    const modelTest = await request(started.baseUrl, '/api/model/test', { method: 'POST' });
    expect(modelTest.response.status).toBe(200);
    expect(modelTest.body.ok).toBe(false);
    expect(modelTest.body.message).toMatch(/未配置/);
  });

  it('exposes the indexed knowledge package, syncs idempotently, and keeps research local without a key', async () => {
    const index = await request(started.baseUrl, '/api/knowledge/index');
    expect(index.response.status).toBe(200);
    expect(index.body.package.available).toBe(true);
    expect(index.body.package.sourceCount).toBe(6);
    expect(index.body.package.ruleCardCount).toBeGreaterThan(0);
    expect(index.body.sources).toHaveLength(6);
    expect(index.body.research).toMatchObject({ configured: false, enabled: false, provider: 'openai', model: 'gpt-4.1' });

    const firstSync = await request(started.baseUrl, '/api/knowledge/sync', { method: 'POST' });
    const secondSync = await request(started.baseUrl, '/api/knowledge/sync', { method: 'POST' });
    expect(firstSync.response.status).toBe(200);
    expect(secondSync.response.status).toBe(200);
    expect(secondSync.body.status.importedCount).toBe(firstSync.body.status.importedCount);

    const local = await request(started.baseUrl, '/api/knowledge/research', jsonInit('POST', { query: 'LVD 适用范围' }));
    expect(local.response.status).toBe(200);
    expect(local.body.mode).toBe('local');
    expect(local.body.webSearchPerformed).toBe(false);
    expect(local.body.checkedAt).toBeNull();
    expect(local.body.answer).toMatch(/未配置/);
    expect(local.body.localEntries.every((entry: any) => entry.metadata?.synthetic !== true)).toBe(true);

    const emptySources = await request(started.baseUrl, '/api/knowledge/research', jsonInit('POST', { query: 'LVD', sourceIds: [] }));
    expect(emptySources.response.status).toBe(400);
    const unknownSource = await request(started.baseUrl, '/api/knowledge/research', jsonInit('POST', { query: 'LVD', sourceIds: ['missing'] }));
    expect(unknownSource.response.status).toBe(400);
    const audit = await request(started.baseUrl, '/api/audit?caseId=knowledge');
    expect(audit.body.some((event: any) => event.type === 'knowledge.researched')).toBe(true);
  });

  it('rejects malformed configuration payloads at every API boundary', async () => {
    for (const config of [{ driver: 123 }, { model: null }, { ip: 'IP' }, null, ['IP44']]) {
      const response = await request(started.baseUrl, '/api/cases', jsonInit('POST', { config }));
      expect(response.response.status).toBe(400);
      expect(response.body.stack).toBeUndefined();
    }
    const created = await request(started.baseUrl, '/api/cases', jsonInit('POST', { name: 'strict analyze case' }));
    expect(created.response.status).toBe(201);
    const invalidAnalyze = await request(started.baseUrl, `/api/cases/${created.body.id}/analyze`, jsonInit('POST', { config: { powerW: '36' } }));
    expect(invalidAnalyze.response.status).toBe(400);
    const invalidPatch = await request(started.baseUrl, `/api/cases/${created.body.id}`, jsonInit('PATCH', { config: { material: 42 } }));
    expect(invalidPatch.response.status).toBe(400);
  });

  it('caches only analysis and invalidates it when report evidence changes', async () => {
    const created = await request(started.baseUrl, '/api/cases', jsonInit('POST', { name: 'analysis cache case', config: { powerW: 36, ip: 'IP44' } }));
    expect(created.response.status).toBe(201);
    const id = created.body.id as string;
    const first = await request(started.baseUrl, `/api/cases/${id}/analyze`, jsonInit('POST', { idempotencyKey: 'report-state-cache' }));
    expect(first.response.status).toBe(200);
    const firstAnalysisId = first.body.analysis.id as string;
    const chat = await request(started.baseUrl, `/api/cases/${id}/chat`, jsonInit('POST', { message: '请先记录此询盘背景。', channel: 'email' }));
    expect(chat.response.status).toBe(200);
    const cached = await request(started.baseUrl, `/api/cases/${id}/analyze`, jsonInit('POST', { idempotencyKey: 'report-state-cache' }));
    expect(cached.response.status).toBe(200);
    expect(cached.body.analysis.id).toBe(firstAnalysisId);
    expect(cached.body.round).toBe(chat.body.round);
    expect(cached.body.messages.length).toBe(chat.body.messages.length);

    const originalReport = (await request(started.baseUrl, '/api/bootstrap')).body.reports.find((report: EvidenceReport) => report.id === 'TR-001') as EvidenceReport;
    const changedCoverage = { ...originalReport.coverage, powerMaxW: (originalReport.coverage.powerMaxW ?? 30) + 1 };
    const rejectedCoverageChange = await request(started.baseUrl, '/api/reports/TR-001', jsonInit('PATCH', { coverage: changedCoverage }));
    expect(rejectedCoverageChange.response.status).toBe(400);
    const unverified = await request(started.baseUrl, '/api/reports/TR-001', jsonInit('PATCH', { verified: false }));
    expect(unverified.response.status).toBe(200);
    const afterVerification = await request(started.baseUrl, `/api/cases/${id}/analyze`, jsonInit('POST', { idempotencyKey: 'report-state-cache' }));
    expect(afterVerification.body.analysis.id).not.toBe(firstAnalysisId);
    const changed = await request(started.baseUrl, '/api/reports/TR-001', jsonInit('PATCH', { coverage: changedCoverage }));
    expect(changed.response.status).toBe(200);
    const afterCoverage = await request(started.baseUrl, `/api/cases/${id}/analyze`, jsonInit('POST', { idempotencyKey: 'report-state-cache' }));
    expect(afterCoverage.body.analysis.id).not.toBe(afterVerification.body.analysis.id);
    const changedPages = originalReport.pages.map((page) => page.page === 1 ? { ...page, text: `${page.text} page-state-change` } : page);
    const pages = await request(started.baseUrl, '/api/reports/TR-001', jsonInit('PATCH', { pages: changedPages }));
    expect(pages.response.status).toBe(200);
    const afterPages = await request(started.baseUrl, `/api/cases/${id}/analyze`, jsonInit('POST', { idempotencyKey: 'report-state-cache' }));
    expect(afterPages.body.analysis.id).not.toBe(afterCoverage.body.analysis.id);
    const reverified = await request(started.baseUrl, '/api/reports/TR-001', jsonInit('PATCH', { coverage: changedCoverage, pages: changedPages, verified: true }));
    expect(reverified.response.status).toBe(200);
    const afterReverify = await request(started.baseUrl, `/api/cases/${id}/analyze`, jsonInit('POST', { idempotencyKey: 'report-state-cache' }));
    expect(afterReverify.body.analysis.id).not.toBe(afterPages.body.analysis.id);
  });

  it('invalidates persisted analysis and quote when evidence verification changes', async () => {
    const created = await request(started.baseUrl, '/api/cases', jsonInit('POST', {
      name: 'evidence freshness regression', config: { powerW: 36, ip: 'IP44' },
    }));
    expect(created.response.status).toBe(201);
    const analyzed = await request(started.baseUrl, `/api/cases/${created.body.id}/analyze`, jsonInit('POST', { idempotencyKey: 'evidence-freshness' }));
    expect(analyzed.response.status).toBe(200);
    expect(analyzed.body.analysis.findings.filter((f: { status: string }) => f.status === 'review').map((f: { itemId: string }) => f.itemId)).toEqual(['emc']);
    const quoted = await request(started.baseUrl, `/api/cases/${created.body.id}/quote`, jsonInit('POST', { channel: 'email' }));
    expect(quoted.response.status).toBe(200);
    expect(quoted.body.quote.en).toMatch(/€2,100|2,100/);

    const unverified = await request(started.baseUrl, '/api/reports/TR-001', jsonInit('PATCH', { verified: false }));
    expect(unverified.response.status).toBe(200);
    const refreshedQuote = await request(started.baseUrl, `/api/cases/${created.body.id}/quote`, jsonInit('POST', { channel: 'email' }));
    expect(refreshedQuote.response.status).toBe(200);
    expect(refreshedQuote.body.analysis.reviewCount).toBeGreaterThan(analyzed.body.analysis.reviewCount);
    expect(refreshedQuote.body.quote.en).toMatch(/pending confirmation|manual review|to be confirmed/i);
    const audit = await request(started.baseUrl, `/api/audit?caseId=${encodeURIComponent(created.body.id)}`);
    expect(audit.body.some((event: any) => event.type === 'evidence.changed')).toBe(true);

    const restored = await request(started.baseUrl, '/api/reports/TR-001', jsonInit('PATCH', { verified: true }));
    expect(restored.response.status).toBe(200);
  });

  it('imports structured JSON evidence and rejects blank or scanned PDF confirmation', async () => {
    const structured = {
      title: 'Structured evidence import',
      kind: 'safety',
      coverage: { series: 'NL-L', powerMinW: 18, powerMaxW: 30, ipLevels: ['IP20'], drivers: ['DRV-A'], materials: ['original-material'], markets: ['DE'], tests: ['temperature'], confidence: 0.91 },
      pages: [{ page: 1, text: 'Structured page one: NL-L 18-30W.' }, { page: 2, text: 'Structured page two: temperature.' }],
    };
    const form = new FormData();
    form.append('file', new Blob([JSON.stringify(structured)], { type: 'application/json' }), 'structured-report.json');
    const uploaded = await request(started.baseUrl, '/api/reports', { method: 'POST', body: form });
    expect(uploaded.response.status).toBe(201);
    expect(uploaded.body.title).toBe(structured.title);
    expect(uploaded.body.kind).toBe('safety');
    expect(uploaded.body.pageCount).toBe(2);
    expect(uploaded.body.pages.map((page: { page: number }) => page.page)).toEqual([1, 2]);
    expect(uploaded.body.coverage.powerMaxW).toBe(30);
    const invalidScopeCoverage = await request(started.baseUrl, `/api/reports/${uploaded.body.id}`, jsonInit('PATCH', {
      testScopes: { temperature: { coverage: { ...structured.coverage, tests: ['ip'] }, page: 1 } },
    }));
    expect(invalidScopeCoverage.response.status).toBe(400);
    const invalidScopePage = await request(started.baseUrl, `/api/reports/${uploaded.body.id}`, jsonInit('PATCH', {
      testScopes: { temperature: { coverage: structured.coverage, page: 99 } },
    }));
    expect(invalidScopePage.response.status).toBe(400);
    const normalizedScope = await request(started.baseUrl, `/api/reports/${uploaded.body.id}`, jsonInit('PATCH', {
      testScopes: { temperature: { coverage: structured.coverage, page: 1, quote: 'not present in source' } },
    }));
    expect(normalizedScope.response.status).toBe(200);
    expect(normalizedScope.body.testScopes.temperature.quote).toBe(structured.pages[0].text);
    const verified = await request(started.baseUrl, `/api/reports/${uploaded.body.id}`, jsonInit('PATCH', { verified: true }));
    expect(verified.response.status).toBe(200);
    const scopeChangeNeedsReconfirmation = await request(started.baseUrl, `/api/reports/${uploaded.body.id}`, jsonInit('PATCH', {
      testScopes: { temperature: { coverage: structured.coverage, page: 2 } },
    }));
    expect(scopeChangeNeedsReconfirmation.response.status).toBe(400);

    const manualForm = new FormData();
    manualForm.append('file', new Blob([JSON.stringify(structured)], { type: 'application/json' }), 'manual-scope-report.json');
    const manualUpload = await request(started.baseUrl, '/api/reports', { method: 'POST', body: manualForm });
    expect(manualUpload.response.status).toBe(201);
    const manualConfirmed = await request(started.baseUrl, `/api/reports/${manualUpload.body.id}`, jsonInit('PATCH', {
      coverage: structured.coverage,
      scopeTests: ['temperature', 'ip'],
      scopePage: 1,
      verified: true,
    }));
    expect(manualConfirmed.response.status).toBe(200);
    expect(manualConfirmed.body.testScopes.temperature.coverage.tests).toEqual(['temperature']);
    expect(manualConfirmed.body.testScopes.ip.coverage.tests).toEqual(['ip']);
    expect(manualConfirmed.body.testScopes.ip.quote).toBe(structured.pages[0].text);

    const blankForm = new FormData();
    blankForm.append('file', new Blob([makePdf(['visible text', '']).toString('binary')], { type: 'application/pdf' }), 'blank-page.pdf');
    const blank = await request(started.baseUrl, '/api/reports', { method: 'POST', body: blankForm });
    expect(blank.response.status).toBe(201);
    expect(blank.body.pageCount).toBe(2);
    expect(blank.body.status).toBe('needs_review');
    const blankVerify = await request(started.baseUrl, `/api/reports/${blank.body.id}`, jsonInit('PATCH', { verified: true }));
    expect(blankVerify.response.status).toBe(400);

    const scanned = await parseUpload({ originalname: 'scanned.pdf', mimetype: 'application/pdf', buffer: makePdf(['', '']) });
    expect(scanned.report.status).toBe('needs_review');
    expect(scanned.report.pages).toHaveLength(2);
    expect(scanned.report.pages.every((page) => page.text.trim() === '')).toBe(true);
    const scannedVerify = await request(started.baseUrl, `/api/reports/${blank.body.id}`, jsonInit('PATCH', { pages: scanned.report.pages, verified: true }));
    expect(scannedVerify.response.status).toBe(400);
  });

  it('uses a local OpenAI-compatible model endpoint and keeps deterministic quote facts', async () => {
    const mock = await startMockModel();
    const previous = { base: process.env.LLM_BASE_URL, key: process.env.LLM_API_KEY, model: process.env.LLM_MODEL };
    process.env.LLM_BASE_URL = mock.baseUrl;
    process.env.LLM_API_KEY = 'local-test-key';
    process.env.LLM_MODEL = 'local-test-model';
    try {
      const created = await request(started.baseUrl, '/api/cases', jsonInit('POST', { name: 'mock model case', quantity: 100, unitPriceEur: 12 }));
      const chat = await request(started.baseUrl, `/api/cases/${created.body.id}/chat`, jsonInit('POST', { message: '客户改为 30W / IP44，暂不承诺交期。', channel: 'rfq' }));
      expect(chat.response.status).toBe(200);
      expect(chat.body.quote.modelMode).toBe('live');
      expect(chat.body.quote.en).toContain('mock model English');
      expect(chat.body.quote.en).toMatch(/quantity 100|Menge 100|100 units/);
      expect(chat.body.quote.internal.sales.join('\n')).toContain('100');
      expect(mock.calls).toBeGreaterThanOrEqual(2);
      const status = await request(started.baseUrl, '/api/model/status');
      expect(status.body.configured).toBe(true);
      const audit = await request(started.baseUrl, `/api/audit?caseId=${encodeURIComponent(created.body.id)}`);
      expect(audit.body.some((event: any) => event.type === 'chat.completed')).toBe(true);
    } finally {
      if (previous.base === undefined) delete process.env.LLM_BASE_URL; else process.env.LLM_BASE_URL = previous.base;
      if (previous.key === undefined) delete process.env.LLM_API_KEY; else process.env.LLM_API_KEY = previous.key;
      if (previous.model === undefined) delete process.env.LLM_MODEL; else process.env.LLM_MODEL = previous.model;
      await new Promise<void>((resolve, reject) => mock.server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it('imports the structured coverage example and reuses its independent scopes', async () => {
    const created = await request(started.baseUrl, '/api/cases', jsonInit('POST', { name: 'isolated scope regression', config: { powerW: 36, ip: 'IP44' } }));
    expect(created.response.status).toBe(201);
    const caseId = created.body.id as string;
    const before = await request(started.baseUrl, `/api/cases/${caseId}/analyze`, jsonInit('POST', { idempotencyKey: 'scope-regression' }));
    expect(before.response.status).toBe(200);
    expect(before.body.analysis.totalCostEur).toBe(2100);

    const source = JSON.parse(await readFile(join(process.cwd(), 'examples/report-coverage.json'), 'utf8')) as Record<string, unknown>;
    expect(source.testScopes).toBeTruthy();
    const form = new FormData();
    form.append('file', new Blob([JSON.stringify(source)], { type: 'application/json' }), 'report-coverage.json');
    const uploaded = await request(started.baseUrl, '/api/reports', { method: 'POST', body: form });
    expect(uploaded.response.status).toBe(201);
    expect(uploaded.body.verified).toBe(false);
    expect(uploaded.body.testScopes.temperature).toBeTruthy();
    expect(uploaded.body.testScopes.ip).toBeTruthy();
    const confirmed = await request(started.baseUrl, `/api/reports/${uploaded.body.id}`, jsonInit('PATCH', { verified: true, notes: '逐项核对示例报告测试项目、页码和原文。' }));
    expect(confirmed.response.status).toBe(200);
    expect(confirmed.body.verified).toBe(true);
    const after = await request(started.baseUrl, `/api/cases/${caseId}/analyze`, jsonInit('POST', { idempotencyKey: 'scope-regression' }));
    expect(after.response.status).toBe(200);
    expect(after.body.analysis.id).not.toBe(before.body.analysis.id);
    expect(after.body.analysis.totalCostEur).toBe(0);
    expect(after.body.analysis.calculation.estimatedDays).toBe(2);
    expect(after.body.analysis.leadTimeDays).toBeNull();
    expect(after.body.analysis.findings.find((f: { itemId: string }) => f.itemId === 'emc').status).toBe('review');
    expect(after.body.analysis.findings.find((finding: any) => finding.itemId === 'temperature')?.status).toBe('reuse');
    expect(after.body.analysis.findings.find((finding: any) => finding.itemId === 'ip')?.status).toBe('reuse');
    expect(after.body.analysis.documentUpdates).toEqual(expect.arrayContaining(['doc', 'label', 'manual']));
  });

  it('retrieves Chinese knowledge for a conversational inquiry and records its source', async () => {
    const entry = await request(started.baseUrl, '/api/knowledge', jsonInit('POST', {
      title: '验收知识：排期确认', content: '报价前先确认实验室排期，德国客户交期变更须跟进，不能承诺原交期。', tags: ['实验室', '排期'],
    }));
    expect(entry.response.status).toBe(201);
    const item = await request(started.baseUrl, '/api/cases', jsonInit('POST', { name: '中文检索验收' }));
    const chat = await request(started.baseUrl, `/api/cases/${item.body.id}/chat`, jsonInit('POST', { message: '请帮我确认实验室排期，然后回复德国客户。' }));
    expect(chat.response.status).toBe(200);
    const audit = await request(started.baseUrl, `/api/audit?caseId=${item.body.id}`);
    const last = audit.body.filter((event: any) => event.type === 'chat.completed').at(-1);
    expect(JSON.parse(last.detail).retrievalIds).toContain(entry.body.id);
    expect(chat.body.quote.warnings.join(' ')).toContain(entry.body.id);
  });

});


import { createServer, type Server } from 'node:http';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AppDatabase } from '../server/db.js';
import { registerWorkflow2 } from '../server/workflow2.js';
import { seedCosts, seedReports } from '../server/seed.js';

type Started = { db: AppDatabase; server: Server; url: string };

async function start(): Promise<Started> {
  const db = new AppDatabase({ dbPath: ':memory:' });
  db.seedIfEmpty({ reports: seedReports, costs: seedCosts });
  const app = express();
  app.use(express.json());
  registerWorkflow2(app, db);
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as { port: number };
  return { db, server, url: `http://127.0.0.1:${address.port}` };
}

async function request(started: Started, path: string, init?: RequestInit): Promise<{ status: number; body: any }> {
  const response = await fetch(`${started.url}${path}`, init);
  return { status: response.status, body: await response.json() };
}

const validRequest = (configs: unknown[]) => ({
  contract_version: 'tradetwin.wf2.v1',
  request_id: 'WF1-test-001',
  scope: { market: 'EU', product_scope: 'indoor_fixed_led_luminaire' },
  configs,
});

describe('workflow2 HTTP contract', () => {
  let started: Started;

  beforeEach(async () => { started = await start(); });
  afterEach(async () => {
    await new Promise<void>((resolve, reject) => started.server.close((error) => error ? reject(error) : resolve()));
    started.db.close();
  });

  it('returns a verified thermal scope and evidence version derived from current evidence and costs', async () => {
    const first = await request(started, '/api/workflow2/envelope');
    expect(first.status).toBe(200);
    expect(first.body.contract_version).toBe('tradetwin.wf2.v1');
    expect(first.body.coverage.report_id).toBe('TR-001');
    expect(first.body.coverage.power_range_w).toEqual({ min: 18, max: 30 });
    expect(first.body.coverage.evidence[0]).toMatchObject({ document_id: 'TR-001', page: 3 });
    expect(first.body.evidence_version).toMatch(/^[a-f0-9]{64}$/);

    const report = started.db.getReport('TR-001')!.report;
    started.db.updateReport({ ...report, pages: [...report.pages, { page: 4, text: 'version change' }], pageCount: 4 });
    const second = await request(started, '/api/workflow2/envelope');
    expect(second.body.evidence_version).not.toBe(first.body.evidence_version);
  });

  it('evaluates 36W/IP44 as 2100 EUR and 8 days with localized retest names', async () => {
    const result = await request(started, '/api/workflow2/evaluate', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(validRequest([{ config_id: 'A', power_w: 36, ip_rating: 'IP44', driver: 'DRV-A' }])),
    });
    expect(result.status).toBe(200);
    expect(result.body.request_id).toBe('WF1-test-001');
    expect(result.body.results[0]).toMatchObject({ config_id: 'A', estimated_cost_eur: 2100, estimated_days: 8, synthetic: true, human_confirmed: false });
    expect(result.body.results[0].retest_items).toEqual(expect.arrayContaining([
      expect.objectContaining({ test_key: 'thermal_rise', name: expect.objectContaining({ zh: expect.any(String), en: expect.any(String), de: expect.any(String) }) }),
      expect.objectContaining({ test_key: 'ingress_protection' }),
    ]));
    expect(result.body.results[0].findings.find((finding: any) => finding.item_key === 'emc_electrical').status).toBe('COVERED');
  });

  it('evaluates 30W/IP44 as the IP-only 900 EUR and 7 day option', async () => {
    const result = await request(started, '/api/workflow2/evaluate', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(validRequest([{ config_id: 'C', power_w: 30, ip_rating: 'IP44', driver: 'DRV-A' }])),
    });
    expect(result.status).toBe(200);
    expect(result.body.results[0]).toMatchObject({ estimated_cost_eur: 900, estimated_days: 7 });
    expect(result.body.results[0].retest_items.map((item: any) => item.test_key)).toEqual(['ingress_protection']);
  });

  it('keeps known retest cost while nulling estimates when evidence is missing or a parameter is unknown', async () => {
    started.db.sqlite.prepare('DELETE FROM reports WHERE id = ?').run('TR-002');
    const missingReport = await request(started, '/api/workflow2/evaluate', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(validRequest([{ config_id: 'A', power_w: 36, ip_rating: 'IP44', driver: 'DRV-A' }])),
    });
    expect(missingReport.status).toBe(200);
    expect(missingReport.body.results[0]).toMatchObject({ estimated_cost_eur: null, estimated_days: null, known_cost_eur: 2100, manual_review_required: true });

    const unknownParameter = await request(started, '/api/workflow2/evaluate', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(validRequest([{ config_id: 'U', power_w: null, ip_rating: 'IP20', driver: 'DRV-A' }])),
    });
    expect(unknownParameter.status).toBe(200);
    expect(unknownParameter.body.results[0]).toMatchObject({ estimated_cost_eur: null, estimated_days: null, known_cost_eur: 0, manual_review_required: true });
  });

  it('rejects unsupported scope, duplicate ids, and invalid configuration values', async () => {
    const unsupported = await request(started, '/api/workflow2/evaluate', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...validRequest([{ config_id: 'A', power_w: 24, ip_rating: 'IP20', driver: 'DRV-A' }]), scope: { market: 'US', product_scope: 'indoor_fixed_led_luminaire' } }),
    });
    expect(unsupported.status).toBe(400);

    const duplicate = await request(started, '/api/workflow2/evaluate', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(validRequest([
        { config_id: 'A', power_w: 24, ip_rating: 'IP20', driver: 'DRV-A' },
        { config_id: 'A', power_w: 30, ip_rating: 'IP44', driver: 'DRV-A' },
      ])),
    });
    expect(duplicate.status).toBe(400);

    const invalid = await request(started, '/api/workflow2/evaluate', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(validRequest([{ config_id: 'A', power_w: -1, ip_rating: 'IP999', driver: '' }])),
    });
    expect(invalid.status).toBe(400);
  });
});

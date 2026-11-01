import { createServer, type Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import { createApp } from '../server/index.js';
import type { AppDatabase } from '../server/db.js';

describe('工作流一同源接入', () => {
  let upstream: Server | undefined;
  let dataDir: string | undefined;

  afterEach(async () => {
    if (upstream?.listening) await new Promise<void>((resolve) => upstream!.close(() => resolve()));
    upstream = undefined;
    if (dataDir) await rm(dataDir, { recursive: true, force: true });
    dataDir = undefined;
    delete process.env.WORKFLOW1_URL;
  });

  it('proxies the sales workspace API without dropping its prefix payload', async () => {
    let received = '';
    let origin: string | undefined;
    upstream = createServer((req, res) => {
      origin = req.headers.origin;
      req.setEncoding('utf8');
      req.on('data', (chunk) => { received += chunk; });
      req.on('end', () => {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ ok: true, path: req.url }));
      });
    });
    await new Promise<void>((resolve) => upstream!.listen(0, '127.0.0.1', resolve));
    process.env.WORKFLOW1_URL = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
    dataDir = await mkdtemp(join(tmpdir(), 'tradetwin-wf1-'));
    const app = createApp({ dataDir, runtimeKnowledge: false });
    const { createServer: startServer } = await import('node:http');
    const server = startServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;

    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/workflow1/analyze`, {
        method: 'POST', headers: { 'content-type': 'application/json', Origin: 'http://localhost:5173' }, body: JSON.stringify({ text: '36W / IP44' }),
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true, path: '/api/analyze' });
      expect(received).toBe('{"text":"36W / IP44"}');
      expect(origin).toBe('http://localhost:5173');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      app.locals.db.close();
    }
  });

  it('returns a recoverable service-unavailable response when workflow one is down', async () => {
    process.env.WORKFLOW1_URL = 'http://127.0.0.1:1';
    dataDir = await mkdtemp(join(tmpdir(), 'tradetwin-wf1-'));
    const app = createApp({ dataDir, runtimeKnowledge: false });
    const { createServer: startServer } = await import('node:http');
    const server = startServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/workflow1/analyze`);
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ code: 'WORKFLOW1_UNAVAILABLE' });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      app.locals.db.close();
    }
  });
});

describe('workflow one case synchronization', () => {
  let app: ReturnType<typeof createApp>;
  let server: Server;
  let upstream: Server | undefined;
  let db: AppDatabase;
  let base: string;
  let dataDir: string;
  let envelope: any;

  const post = async (result: unknown) => {
    const response = await fetch(`${base}/api/workflow1/sync`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(result) });
    return { status: response.status, body: await response.json() as any };
  };
  const option = (id = 'A', power = 36) => ({
    option_id: id, kind: id === 'A' ? 'requested' : 'within_coverage',
    config: { power_w: power, ip_rating: 'IP44', driver: 'DRV-A' }, quantity: 2000,
    unit_price_eur: power === 30 ? 22.45 : 24.05,
    estimated_cost_eur: power === 30 ? 900 : 2100, estimated_days: power === 30 ? 7 : 8,
    lead_time_working_days: power === 30 ? 27 : 28,
    days_breakdown: { new_driver_sample: 0, lab_parallel: power === 30 ? 5 : 6, document_update: 2 },
    retest_items: power === 30 ? ['ingress_protection'] : ['thermal_rise', 'ingress_protection'],
    document_updates: ['DoC', 'label', 'German instructions'], findings: [],
    assumption_version: 'COST-DEMO-V0.1', source_type: 'synthetic_demo_mapping', synthetic: true, human_confirmed: false,
  });
  const result = (patch: Record<string, unknown> = {}) => ({
    session_id: 'session-1', run_id: 'RUN-1', round: 1, created_at: '2026-11-01T01:00:00.000Z',
    channel: 'email', status: 'NEEDS_MANUAL_REVIEW', mode: 'options',
    buyer_name: 'Anna Becker', subject: 'Bathroom project', input: { text: '36W IP44, 2000 pcs', source: 'manual' },
    workflow2: { ok: true, provider: 'http', rule_version: envelope.rule_version, evidence_version: envelope.evidence_version },
    scope: { market: 'EU', product_scope: 'indoor_fixed_led_luminaire', rule_version: envelope.rule_version, evidence_version: envelope.evidence_version },
    change_order: [{ field: 'power_w', to: 36 }, { field: 'ip_rating', to: 'IP44' }, { field: 'driver', to: 'DRV-A' }, { field: 'quantity', to: 2000 }],
    quote_options: [option(), option('C', 30)], candidate_options: [], selected_option_id: null,
    replies: { en: { subject: 'Your project', body: 'IP retest is required.' }, de: { subject: 'Ihr Projekt', body: 'IP-Prüfung erforderlich.' } },
    owner_actions: [{ owner_role: 'QUALITY_COMPLIANCE', action: 'Confirm laboratory slot' }], ...patch,
  });

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'tradetwin-sync-'));
    app = createApp({ dataDir, runtimeKnowledge: false });
    db = app.locals.db;
    server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    envelope = await (await fetch(`${base}/api/workflow2/envelope`)).json();
  });
  afterEach(async () => {
    if (upstream?.listening) await new Promise<void>((resolve) => upstream!.close(() => resolve()));
    upstream = undefined;
    vi.restoreAllMocks();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  const createCapture = (id = 'capture-1', sessionId = 'extension-session-1') => db.createCapture({
    id, sessionId, text: '36W IP44, 2000 pcs', sourceUrl: 'https://message.alibaba.com/chat?buyerId=42',
    createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 600_000).toISOString(), status: 'pending',
  });
  const importCapture = (id = 'capture-1') => fetch(`${base}/api/extension/captures/${id}/import`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
  });
  const startAnalyze = (makeResult: (body: any) => unknown) => new Promise<void>((resolve) => {
    upstream = createServer((req, res) => {
      let raw = '';
      req.setEncoding('utf8');
      req.on('data', (chunk) => { raw += chunk; });
      req.on('end', () => {
        const body = JSON.parse(raw);
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(makeResult(body)));
      });
    });
    upstream.listen(0, '127.0.0.1', () => {
      process.env.WORKFLOW1_URL = `http://127.0.0.1:${(upstream!.address() as AddressInfo).port}`;
      resolve();
    });
  });

  it('uses the selected configuration, quantity and buyer metadata and audits exactly once', async () => {
    const selected = result({ selected_option_id: 'C' });
    const first = await post(selected);
    expect(first.status).toBe(200);
    expect(first.body.case.requestedConfig).toMatchObject({ powerW: 30, ip: 'IP44', driver: 'DRV-A' });
    expect(first.body.case).toMatchObject({ quantity: 2000, buyer: 'Anna Becker', name: 'Bathroom project', unitPriceEur: 0, workflow1QuoteReady: false, workflow1EvidenceVersion: envelope.evidence_version });
    expect(first.body.case.workflow1PendingReason).toContain('补测费用或排期');
    expect((await post(selected)).body.replay).toBe(true);
    const events = db.listAudit('session-1').filter((event) => event.type === 'workflow1.synced');
    expect(events).toHaveLength(1);
    expect(JSON.parse(events[0]!.detail)).toMatchObject({ result: selected, evidenceVersion: envelope.evidence_version, quoteReady: false, optionCount: 2 });
  });

  it('imports an extension capture into a shared case using its stable session id', async () => {
    const capture = createCapture();
    let received: any;
    await startAnalyze((body) => {
      received = body;
      return result({ session_id: body.session_id, channel: body.channel, input: { text: body.text, source: body.source } });
    });

    const response = await importCapture(capture.id);
    expect(response.status).toBe(200);
    const body = await response.json() as any;
    expect(received).toMatchObject({ text: capture.text, session_id: capture.sessionId, channel: 'alibaba_rfq', source: 'extension' });
    expect(body).toMatchObject({ replay: false, case: { id: capture.sessionId, channel: 'rfq', inquiry: capture.text } });
    expect(db.getCapture(capture.id)).toMatchObject({ status: 'imported', caseId: capture.sessionId });
  });

  it('replays a completed capture import without another analyze or audit event', async () => {
    const capture = createCapture();
    let analyzeCount = 0;
    await startAnalyze((body) => {
      analyzeCount += 1;
      return result({ session_id: body.session_id, channel: body.channel, input: { text: body.text } });
    });

    const first = await importCapture(capture.id);
    const second = await importCapture(capture.id);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(await second.json()).toMatchObject({ replay: true, case: { id: capture.sessionId } });
    expect(analyzeCount).toBe(1);
    expect(db.listAudit(capture.sessionId).filter((event) => event.type === 'workflow1.synced')).toHaveLength(1);
  });

  it('rejects an invalid workflow-one result and keeps the capture pending', async () => {
    const capture = createCapture();
    await startAnalyze(() => ({ session_id: capture.sessionId, run_id: '', round: 1 }));

    const response = await importCapture(capture.id);
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ code: 'INVALID_WORKFLOW1_RESULT' });
    expect(db.getCapture(capture.id)).toMatchObject({ status: 'pending' });
  });

  it('leaves a capture pending when workflow one is unavailable', async () => {
    const capture = createCapture();
    process.env.WORKFLOW1_URL = 'http://127.0.0.1:1';

    const response = await importCapture(capture.id);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: 'WORKFLOW1_UNAVAILABLE' });
    expect(db.getCapture(capture.id)).toMatchObject({ status: 'pending' });
  });

  it('replays any earlier run without overwriting the current case and rejects unseen old rounds', async () => {
    await post(result());
    await post(result({ run_id: 'RUN-2', round: 2, selected_option_id: 'C' }));
    const replay = await post(result());
    expect(replay.body).toMatchObject({ replay: true, case: { round: 2, workflow1LastRunId: 'RUN-2', requestedConfig: { powerW: 30 } } });
    expect((await post(result({ run_id: 'UNSEEN', round: 2 }))).status).toBe(409);
    expect(db.listAudit('session-1')).toHaveLength(2);
  });

  it('clears a stale price and legacy quote for pending results while preserving a candidate selection', async () => {
    await post(result());
    const saved = db.getCase('session-1')!;
    saved.quote = { id: 'old', channel: 'email', en: 'old', de: 'old', internal: { sales: [], quality: [], procurement: [] }, modelMode: 'demo', modelName: 'template', warnings: [], generatedAt: saved.updatedAt };
    db.saveCase(saved);
    const pending = await post(result({ run_id: 'RUN-2', round: 2, mode: 'pending_check', quote_options: [], candidate_options: [{ option_id: 'C', kind: 'within_coverage', config: option('C', 30).config }], selected_option_id: 'C' }));
    expect(pending.body.case).toMatchObject({ workflow1QuoteReady: false, unitPriceEur: 0, quote: null, requestedConfig: { powerW: 30 } });
  });

  it.each([
    ['failed evaluation', { workflow2: { ok: false } }],
    ['invalid round', { round: 0 }],
    ['invalid timestamp', { created_at: 'yesterday' }],
    ['unknown selection', { selected_option_id: 'Z' }],
    ['duplicate options', { quote_options: [option(), option()] }],
    ['unknown estimate', { quote_options: [{ ...option(), estimated_days: null }] }],
    ['negative price', { quote_options: [{ ...option(), unit_price_eur: -1 }] }],
    ['invalid quantity', { change_order: [{ field: 'quantity', to: -10 }] }],
    ['invalid option config', { quote_options: [{ ...option(), config: { power_w: 0, ip_rating: 'IP44', driver: 'DRV-A' } }] }],
    ['mismatched versions', { scope: { market: 'EU', product_scope: 'indoor_fixed_led_luminaire', rule_version: 'different', evidence_version: 'different' } }],
  ])('rejects malformed commercial results: %s', async (_label, patch) => {
    expect((await post(result(patch))).status).toBe(400);
    expect(db.getCase('session-1')).toBeNull();
  });

  it('keeps priced results pending when current evidence or deterministic totals disagree', async () => {
    const report = db.getReport('TR-001')!.report;
    db.updateReport({ ...report, notes: 'new review version' });
    const stale = await post(result());
    expect(stale.body.case.workflow1QuoteReady).toBe(false);
    expect(stale.body.case.unitPriceEur).toBe(0);
    envelope = await (await fetch(`${base}/api/workflow2/envelope`)).json();
    const inconsistent = await post(result({ run_id: 'RUN-2', round: 2, quote_options: [{ ...option(), estimated_cost_eur: 1 }] }));
    expect(inconsistent.body.case.workflow1QuoteReady).toBe(false);
  });

  it('preserves unsupported quality material and market as pending instead of resetting them', async () => {
    await post(result());
    const saved = db.getCase('session-1')!;
    saved.requestedConfig.material = 'changed-material';
    saved.requestedConfig.market = 'US';
    db.saveCase(saved);
    const next = await post(result({ run_id: 'RUN-2', round: 2 }));
    expect(next.body.case.requestedConfig).toMatchObject({ material: 'changed-material', market: 'US' });
    expect(next.body.case.workflow1QuoteReady).toBe(false);
  });

  it('rolls back the case and audit if cache persistence fails', async () => {
    vi.spyOn(db, 'cacheRequest').mockImplementation(() => { throw new Error('cache write failed'); });
    expect((await post(result())).status).toBe(500);
    expect(db.getCase('session-1')).toBeNull();
    expect(db.listAudit('session-1')).toHaveLength(0);
  });

  it('exports workflow one options, replies, actions, versions and historical runs', async () => {
    await post(result());
    await post(result({ run_id: 'RUN-2', round: 2, selected_option_id: 'C' }));
    const exported = await (await fetch(`${base}/api/cases/session-1/export`)).text();
    for (const value of ['RUN-1', 'RUN-2', '22.45', 'IP-Prüfung erforderlich.', 'Confirm laboratory slot', envelope.evidence_version, 'workflow1.synced']) expect(exported).toContain(value);
  });

  it('rejects a nonlocal Origin on settings mutations at the Node boundary', async () => {
    const response = await fetch(`${base}/api/workflow1/settings/mail/clear`, { method: 'POST', headers: { 'content-type': 'application/json', Origin: 'https://untrusted.example' }, body: '{}' });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: 'NONLOCAL_ORIGIN' });
  });

  it('invalidates readiness on evidence updates and quality configuration edits without deleting the saved result', async () => {
    await post(result());
    const changed = await fetch(`${base}/api/cases/session-1`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ config: { powerW: 28 } }) });
    expect(await changed.json()).toMatchObject({ workflow1QuoteReady: false, unitPriceEur: 0, workflow1Result: { run_id: 'RUN-1' } });
    await post(result({ run_id: 'RUN-2', round: 2 }));
    const report = db.getReport('TR-001')!.report;
    const updated = await fetch(`${base}/api/reports/TR-001`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ notes: `${report.notes} reviewed` }) });
    expect(updated.status).toBe(200);
    const loaded = await (await fetch(`${base}/api/cases/session-1`)).json();
    expect(loaded).toMatchObject({ workflow1QuoteReady: false, unitPriceEur: 0, workflow1Result: { run_id: 'RUN-2' } });
    const bootstrap: any = await (await fetch(`${base}/api/bootstrap`)).json();
    expect(bootstrap.cases.find((item: any) => item.id === 'session-1').workflow1QuoteReady).toBe(false);
    expect(db.listAudit('session-1').filter((event) => event.type === 'workflow1.synced')).toHaveLength(2);
  });

  it('sets and clears the delivery hold using the workflow constraints contract', async () => {
    const held = await post(result({ constraints: { hide_delivery_date: true } }));
    expect(held.body.case.commitment).toBe('暂不承诺具体交期');
    const cleared = await post(result({ run_id: 'RUN-2', round: 2, constraints: { hide_delivery_date: false } }));
    expect(cleared.body.case.commitment).toBe('');
  });

  it.each([['quantity', 50], ['channel', 'rfq']])('demotes readiness when persisted %s no longer matches the priced round', async (field, value) => {
    await post(result());
    const saved = db.getCase('session-1')!;
    Object.assign(saved, { [field]: value });
    db.saveCase(saved);
    const loaded = await (await fetch(`${base}/api/cases/session-1`)).json();
    expect(loaded).toMatchObject({ workflow1QuoteReady: false, unitPriceEur: 0 });
  });

  it('returns pending readiness immediately when quality analyzes a changed configuration', async () => {
    await post(result());
    const response = await fetch(`${base}/api/cases/session-1/analyze`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ config: { powerW: 28 } }) });
    expect(await response.json()).toMatchObject({ workflow1QuoteReady: false, unitPriceEur: 0 });
  });
});

// Execute the actual embedded workspace script against a small DOM/fetch boundary.
// In particular, restoring a session must never call an analysis mutation.
async function salesPage(options: { session?: any; caseRecord?: any; sessionId?: string; fetchOverride?: (path: string, body: any) => Promise<any> | undefined } = {}) {
  const nodes = new Map<string, any>();
  const element = (selector: string): any => {
    if (nodes.has(selector)) return nodes.get(selector);
    const classes = new Set(['hidden']);
    let html = '';
    const node: any = { value: '', dataset: {}, textContent: '', disabled: false, listeners: {},
      classList: { add: (key: string) => classes.add(key), remove: (key: string) => classes.delete(key), contains: (key: string) => classes.has(key), toggle: (key: string, on: boolean) => on ? classes.add(key) : classes.delete(key) },
      addEventListener: (name: string, fn: any) => { node.listeners[name] = fn; },
      appendChild: (child: any) => { if (child.id) nodes.set(`#${child.id}`, child); },
      prepend: (child: any) => { if (child.id) nodes.set(`#${child.id}`, child); },
      insertAdjacentHTML: (_position: string, value: string) => { node.innerHTML += value; },
      elements: Object.fromEntries(['user', 'password', 'imap_host', 'imap_port', 'drafts_folder', 'signature'].map((name) => [name, { value: '', addEventListener: () => {} }])),
    };
    Object.defineProperty(node, 'innerHTML', { get: () => html, set: (value: string) => {
      html = value;
      for (const tag of value.matchAll(/<[^>]+id="([^"]+)"[^>]*>/g)) {
        const child = element(`#${tag[1]}`);
        const inputValue = tag[0].match(/value="([^"]*)"/);
        if (inputValue) child.value = inputValue[1];
      }
    } });
    nodes.set(selector, node); return node;
  };
  for (const match of readFileSync(new URL('../workflow-1/app/tradetwin/static/index.html', import.meta.url), 'utf8').matchAll(/id="([^"]+)"/g)) element(`#${match[1]}`);
  const calls: { path: string; body?: any }[] = [];
  const messages: any[] = [];
  const caseRecord = options.caseRecord;
  const fetchBoundary = async (path: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ path, body });
    const overridden = options.fetchOverride?.(path, body);
    if (overridden) return overridden;
    let data: any, status = 200;
    if (path.endsWith('/health')) data = { mail: { mode: 'offline' }, workflow2: { ok: true, provider: 'http' }, baseline: { model: 'NL-L', power_w: 24, ip_rating: 'IP20', driver: 'DRV-A' } };
    else if (path.includes('/mail/threads')) data = { status: { mode: 'offline' }, threads: [] };
    else if (path.includes('/session/')) { data = options.session || { detail: 'not found' }; if (!options.session) status = 404; }
    else if (path.includes('/api/cases/')) { data = caseRecord || {}; if (!caseRecord) status = 404; }
    else if (path.endsWith('/sync')) data = { case: caseRecord, replay: false };
    else if (path.endsWith('/analyze') || path.endsWith('/instruct')) data = options.session?.last_result || uiResult();
    else throw new Error(`Unexpected request ${path}`);
    return { ok: status < 400, status, json: async () => data };
  };
  const context = createContext({ document: { querySelector: element, querySelectorAll: () => [], createElement: () => element(`new-${nodes.size}`) },
    window: { location: new URL(`http://localhost:5173/sales/?session_id=${options.sessionId || 'session-1'}`), parent: { postMessage: (message: any) => messages.push(message) }, history: { replaceState: () => {} } },
    history: { replaceState: () => {} }, URL, URLSearchParams, fetch: fetchBoundary,
    setTimeout: () => 1, clearTimeout: () => {}, setInterval: () => 1, clearInterval: () => {}, console,
  });
  await runInContext(readFileSync(new URL('../workflow-1/app/tradetwin/static/app.js', import.meta.url), 'utf8'), context);
  await new Promise<void>((resolve) => setImmediate(resolve));
  return { nodes, calls, messages, state: runInContext('state', context), run: (script: string) => runInContext(script, context) };
}

const uiResult = (patch: any = {}) => ({
  session_id: 'session-1', run_id: 'RUN-2', round: 2, channel: 'email', kind: 'instruction',
  status: 'NEEDS_MANUAL_REVIEW', extraction: { method: 'rules', language: 'en', warnings: [] },
  scope: { market: 'EU' }, workflow2: { ok: true, provider: 'http', warnings: [] },
  input: { source: 'manual', text: '30W IP44' },
  change_order: [{ field: 'power_w', to: 30 }, { field: 'ip_rating', to: 'IP44' }, { field: 'driver', to: 'DRV-A' }, { field: 'quantity', to: 2000 }],
  coverage_findings: [], quote_options: [], candidate_options: [], questions: [], consistency_issues: [], owner_actions: [], assumptions: [],
  replies: { en: { subject: 'Project', body: 'Please confirm.', generator: 'template', check: { level: 'green', annotations: [], counts: { high: 0, medium: 0, low: 0 } } } }, ...patch,
});
const uiCase = (patch: any = {}) => ({ id: 'session-1', buyer: 'Anna', name: 'Project', requestedConfig: { model: 'NL-L', powerW: 30, ip: 'IP44', driver: 'DRV-A', material: 'original-material', market: 'DE' }, quantity: 2000, channel: 'email', workflow1QuoteReady: false, workflow1LastRunId: 'RUN-2', ...patch });

describe('sales workspace restoration and quality handoff', () => {
  it('publishes synchronization pending before a new analysis request and keeps it pending until that result is saved', async () => {
    let finishSync: (value: any) => void = () => {};
    let messageAtAnalyze: any;
    const page = await salesPage({ caseRecord: uiCase(), fetchOverride: (path) => {
      if (path.endsWith('/sync')) return new Promise((resolve) => { finishSync = resolve; });
      if (path.endsWith('/analyze')) { messageAtAnalyze = page.messages.at(-1); return Promise.resolve({ ok: true, json: async () => uiResult({ run_id: 'RUN-3', round: 3 }) }); }
    } });
    page.nodes.get('#manual-text').value = '28W IP44 same driver';
    page.nodes.get('#manual-channel').value = 'email';
    await page.nodes.get('#btn-manual').listeners.click({ target: page.nodes.get('#btn-manual') });
    expect(messageAtAnalyze).toMatchObject({ sync_status: 'syncing' });
    expect(page.state.result.run_id).toBe('RUN-3');
    expect(page.messages.at(-1)).toMatchObject({ sync_status: 'syncing', run_id: 'RUN-3' });
    finishSync({ ok: true, json: async () => ({ case: uiCase({ workflow1LastRunId: 'RUN-3' }) }) });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(page.messages.at(-1)).toMatchObject({ sync_status: 'synced', run_id: 'RUN-3' });
  });

  it('retries a failed synchronization using the identical result without producing another round', async () => {
    let attempts = 0;
    const page = await salesPage({ caseRecord: uiCase(), fetchOverride: (path) => {
      if (path.endsWith('/sync')) return Promise.resolve(++attempts === 1
        ? { ok: false, status: 503, json: async () => ({ message: 'retry this result' }) }
        : { ok: true, json: async () => ({ case: uiCase() }) });
    } });
    page.nodes.get('#manual-text').value = '30W IP44 same driver';
    page.nodes.get('#manual-channel').value = 'email';
    await page.nodes.get('#btn-manual').listeners.click({ target: page.nodes.get('#btn-manual') });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(page.messages.at(-1)).toMatchObject({ sync_status: 'error', retryable: true });
    await page.nodes.get('#btn-retry-sync').listeners.click({ target: page.nodes.get('#btn-retry-sync') });
    const syncs = page.calls.filter((call) => call.path.endsWith('/sync'));
    expect(syncs).toHaveLength(2);
    expect(syncs[0]!.body).toEqual(syncs[1]!.body);
    expect(page.calls.filter((call) => call.path.endsWith('/analyze'))).toHaveLength(1);
    expect(page.messages.at(-1)).toMatchObject({ sync_status: 'synced' });
  });

  it('ignores late synchronization responses after a newer result has started syncing', async () => {
    const pending: ((value: any) => void)[] = [];
    const page = await salesPage({ caseRecord: uiCase(), fetchOverride: (path) => path.endsWith('/sync') ? new Promise((resolve) => pending.push(resolve)) : undefined });
    page.run(`show(${JSON.stringify(uiResult({ run_id: 'RUN-old', round: 3 }))})`);
    page.run(`show(${JSON.stringify(uiResult({ run_id: 'RUN-new', round: 4 }))})`);
    pending[1]!({ ok: true, json: async () => ({ case: uiCase({ workflow1LastRunId: 'RUN-new' }) }) });
    await new Promise<void>((resolve) => setImmediate(resolve));
    pending[0]!({ ok: true, json: async () => ({ case: uiCase({ workflow1LastRunId: 'RUN-old' }) }) });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(page.messages.at(-1)).toMatchObject({ sync_status: 'synced', run_id: 'RUN-new' });
    expect(page.state.sharedCase.workflow1LastRunId).toBe('RUN-new');
  });

  it('restores URL session history without producing another buyer round and publishes current readiness', async () => {
    const previous = uiResult({ run_id: 'RUN-1', round: 1 });
    const last = uiResult();
    const page = await salesPage({ session: { session_id: 'session-1', history: [previous, last], last_result: last, buyer_name: 'Anna', subject: 'Project' }, caseRecord: uiCase() });
    expect(page.state.sessionId).toBe('session-1');
    expect(page.state.result.run_id).toBe('RUN-2');
    expect(page.state.previous.run_id).toBe('RUN-1');
    expect(page.calls.filter((call) => call.body)).toHaveLength(0);
    expect(page.messages.at(-1)).toMatchObject({ shared_case_id: 'session-1', workflow1QuoteReady: false });
  });

  it('presents a Node-only configuration for editing and confirmation before analyzing the same session', async () => {
    const page = await salesPage({ caseRecord: uiCase() });
    expect(page.calls.filter((call) => call.body)).toHaveLength(0);
    expect(page.nodes.get('#handoff-power').value).toBe('30');
    page.nodes.get('#handoff-power').value = '28';
    await page.nodes.get('#btn-apply-handoff').listeners.click({ target: page.nodes.get('#btn-apply-handoff') });
    const analyzed = page.calls.find((call) => call.path.endsWith('/analyze'));
    expect(analyzed?.body).toMatchObject({ session_id: 'session-1', source: 'quality_handoff' });
    expect(analyzed?.body.text).toContain('28W');
  });

  it('offers visible recomputation when quality config differs from the saved buyer round', async () => {
    const last = uiResult();
    const page = await salesPage({ session: { session_id: 'session-1', history: [last], last_result: last }, caseRecord: uiCase({ requestedConfig: { ...uiCase().requestedConfig, powerW: 28, material: 'changed-material', market: 'US' } }) });
    expect(page.calls.filter((call) => call.body)).toHaveLength(0);
    expect(page.nodes.get('#shared-handoff').classList.contains('hidden')).toBe(false);
    expect(page.nodes.get('#handoff-material').value).toBe('changed-material');
    expect(page.nodes.get('#handoff-market').value).toBe('US');
    await page.nodes.get('#btn-apply-handoff').listeners.click({ target: page.nodes.get('#btn-apply-handoff') });
    const applied = page.calls.find((call) => call.path.endsWith('/instruct'));
    expect(applied?.body).toMatchObject({ session_id: 'session-1' });
    expect(applied?.body.instruction).toContain('28W');
    expect(applied?.body.instruction).toContain('changed-material');
  });

  it('manual analysis retains the restored shared case identity', async () => {
    const page = await salesPage({ caseRecord: uiCase() });
    page.nodes.get('#manual-text').value = '30W IP44 same driver';
    page.nodes.get('#manual-channel').value = 'email';
    await page.nodes.get('#btn-manual').listeners.click({ target: page.nodes.get('#btn-manual') });
    expect(page.calls.find((call) => call.path.endsWith('/analyze'))?.body.session_id).toBe('session-1');
  });
});

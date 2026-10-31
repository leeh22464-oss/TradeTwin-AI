import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateQuote, getModelStatus } from '../server/model';
import { analyzeChange } from '../server/engine';
import { createSeedCase, seedReports } from '../server/seed';

beforeEach(() => {
  // Keep the legacy compatibility tests hermetic even when a developer's
  // dotenv file contains an official key. No test in this file may make a
  // paid external request.
  vi.stubEnv('OPENAI_API_KEY', '');
  vi.stubEnv('OPENAI_MODEL', '');
  vi.stubEnv('LLM_BASE_URL', '');
  vi.stubEnv('LLM_API_KEY', '');
  vi.stubEnv('LLM_MODEL', '');
});
afterEach(() => vi.unstubAllEnvs());

function analyzedCase() {
  const item = createSeedCase();
  item.analysis = analyzeChange(item.requestedConfig, seedReports);
  return item;
}

async function withModel(en: string, de: string, run: () => Promise<void>) {
  const server = createServer((_req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
      en, de, sales: ['仅供测试的模型内容'], quality: ['模型不得代替规则'], procurement: ['以确定性输出为准'],
    }) } }] }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  vi.stubEnv('LLM_BASE_URL', `http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  vi.stubEnv('LLM_API_KEY', 'local-test-key');
  vi.stubEnv('LLM_MODEL', 'local-test-model');
  try { await run(); } finally { await new Promise<void>((resolve, reject) => server.close((e) => e ? reject(e) : resolve())); }
}

describe('localized quote fact boundaries', () => {
  it('renders real rule costs, unit allocation and Chinese role tasks in demo mode', async () => {
    const quote = await generateQuote(analyzedCase(), 'email');
    expect(quote.modelMode).toBe('demo');
    expect(quote.en).toContain('€2,100');
    expect(quote.en).toContain('€22.70');
    expect(quote.de).toContain('Wasserschutz');
    expect(quote.internal.quality.join(' ')).toContain('温升');
    expect(quote.internal.procurement.join(' ')).toContain('防尘防水');
  });

  it('keeps unknown compliance costs pending instead of quoting zero', async () => {
    const item = analyzedCase();
    item.requestedConfig.driver = null;
    item.analysis = analyzeChange(item.requestedConfig, seedReports);
    expect(item.analysis.canQuote).toBe(false);
    const quote = await generateQuote(item, 'rfq');
    expect(quote.en).toContain('to be confirmed after manual review');
    expect(quote.en).not.toContain('€0.00 per unit');
  });

  it('allows a bounded model introduction and appends deterministic business terms', async () => {
    await withModel('Thank you for clarifying your preferences.', 'Vielen Dank für Ihre Nachricht.', async () => {
      const quote = await generateQuote(analyzedCase(), 'email');
      expect(quote.modelMode).toBe('live');
      expect(quote.en).toContain('Thank you for clarifying');
      expect(quote.en).toContain('€2,100');
      expect(quote.internal.sales.join(' ')).not.toContain('仅供测试的模型内容');
    });
  });

  it('rejects model-authored monetary or certification commitments', async () => {
    await withModel('We guarantee certification for €9,999.', 'Alles ist garantiert.', async () => {
      const quote = await generateQuote(analyzedCase(), 'email');
      expect(quote.modelMode).toBe('fallback');
      expect(quote.en).not.toContain('€9,999');
      expect(quote.en).toContain('€2,100');
      expect(quote.warnings.join(' ')).toContain('模型回退');
    });
  });

  it('removes a specific delivery interval after the buyer requests a hold', async () => {
    const item = analyzedCase();
    item.commitment = '暂不承诺具体交期';
    const quote = await generateQuote(item, 'rfq');
    expect(quote.en).toContain('no specific delivery commitment');
    expect(quote.en).not.toContain('8 working days');
    expect(quote.de).toContain('nicht zugesagt');
  });

  it('uses the fixed official Responses endpoint without redirecting an OPENAI key', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'official-test-key');
    vi.stubEnv('OPENAI_MODEL', 'gpt-4.1');
    vi.stubEnv('LLM_BASE_URL', 'http://127.0.0.1:9/should-not-be-used');
    vi.stubEnv('LLM_API_KEY', 'legacy-key');
    vi.stubEnv('LLM_MODEL', 'legacy-model');
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url, init) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response(JSON.stringify({
        output_text: JSON.stringify({
          en: 'Thank you for clarifying your preferences.', de: 'Vielen Dank für Ihre Nachricht.',
          sales: ['ignored'], quality: ['ignored'], procurement: ['ignored'],
        }),
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    try {
      const quote = await generateQuote(analyzedCase(), 'email');
      expect(quote.modelMode).toBe('live');
      expect(getModelStatus()).toMatchObject({ configured: true, mode: 'live', model: 'gpt-4.1', baseUrl: 'https://api.openai.com/v1' });
      expect(calls).toHaveLength(1);
      expect(calls[0].url).toBe('https://api.openai.com/v1/responses');
      const body = JSON.parse(String(calls[0].init.body));
      expect(body.text).toEqual({ format: { type: 'json_object' } });
      expect(body.temperature).toBeUndefined();
      expect(body.store).toBe(false);
      expect(calls[0].init.headers).toMatchObject({ authorization: 'Bearer official-test-key' });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

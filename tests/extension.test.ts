import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

class Element {
  tagName: string;
  parentElement: Element | null = null;
  children: Element[] = [];
  value = '';
  innerText: string;
  isConnected = true;
  hidden = false;
  style = { display: 'block', visibility: 'visible', opacity: '1' };
  events: string[] = [];
  listeners: Record<string, (event: any) => unknown> = {};
  classList = { toggle: () => {}, add: () => {}, remove: () => {} };
  disabled = false;
  innerHTML = '';
  textContent = '';
  dataset = {};
  constructor(tag = 'div', public attrs: Record<string, string> = {}, text = '') {
    this.tagName = tag.toUpperCase(); this.innerText = text;
  }
  get type() { return this.attrs.type || ''; }
  get isContentEditable(): boolean { return this.attrs.contenteditable === 'true' || !!this.parentElement?.isContentEditable; }
  getAttribute(name: string) { return this.attrs[name] ?? null; }
  matches(selector: string): boolean {
    return selector.split(',').some((part) => {
      const s = part.trim();
      if (s.startsWith('.')) return (this.attrs.class || '').split(/\s+/).includes(s.slice(1));
      const attr = s.match(/^\[([^=\]]+)(?:=["']?([^"'\]]+)["']?)?\]$/);
      if (attr) return attr[2] === undefined ? attr[1] in this.attrs : this.attrs[attr[1]] === attr[2];
      return this.tagName.toLowerCase() === s.toLowerCase();
    });
  }
  closest(selector: string): Element | null { return this.matches(selector) ? this : this.parentElement?.closest(selector) || null; }
  contains(other: Element): boolean { return other === this || this.children.some((c) => c.contains(other)); }
  querySelectorAll(selector: string): Element[] { return this.children.flatMap((c) => [...(c.matches(selector) ? [c] : []), ...c.querySelectorAll(selector)]); }
  querySelector(selector: string) { return this.querySelectorAll(selector)[0] || null; }
  getClientRects() { return this.hidden || this.style.display === 'none' ? [] : [{}]; }
  add(...children: Element[]) { children.forEach((c) => { c.parentElement = this; this.children.push(c); }); return this; }
  focus() {}
  dispatchEvent(event: Event) { this.events.push(event.type); return true; }
  addEventListener(type: string, listener: (event: any) => unknown) { this.listeners[type] = listener; }
}

const inbound = (text: string) => new Element('div', { 'data-message-direction': 'incoming' }, text);
const outbound = (text: string) => new Element('div', { 'data-message-direction': 'outgoing' }, text);
function content(options: { selection?: string; nodes?: Element[]; active?: Element; url?: string } = {}) {
  const root = new Element().add(...(options.nodes || []));
  if (options.active && !root.contains(options.active)) root.add(options.active);
  let listener: (message: any, sender: any, reply: (value: any) => void) => void = () => {};
  const document = {
    activeElement: options.active || root,
    contains: (el: Element) => el.isConnected && root.contains(el),
    querySelectorAll: (selector: string) => root.querySelectorAll(selector),
    querySelector: (selector: string) => root.querySelector(selector),
    addEventListener: () => {},
  };
  runInNewContext(readFileSync(new URL('../workflow-1/extension/content.js', import.meta.url), 'utf8'), {
    window: { getSelection: () => options.selection || '' }, document,
    location: new URL(options.url || 'https://message.alibaba.com/chat'), URL, URLSearchParams, Event,
    getComputedStyle: (el: Element) => el.style,
    chrome: { runtime: { onMessage: { addListener: (fn: typeof listener) => { listener = fn; } } } },
  });
  return (type: string, extra = {}) => { let result: any; listener({ type, ...extra }, {}, (value) => { result = value; }); return result; };
}

describe('Alibaba content-script message boundary', () => {
  it('prefers selected text over recent inbound text', () => {
    expect(content({ selection: 'selected buyer text', nodes: [inbound('recent')] })('tt-read'))
      .toMatchObject({ selection: 'selected buyer text', source: 'selection' });
  });
  it('reads only the final visible inbound message', () => {
    const hidden = inbound('hidden'); hidden.hidden = true;
    const detached = inbound('detached'); detached.isConnected = false;
    const editor = inbound('draft').add(new Element('textarea', {}, 'draft'));
    editor.attrs.contenteditable = 'true';
    const nestedOutgoing = outbound('my words').add(inbound('wrong incoming marker'));
    expect(content({ nodes: [inbound('first'), outbound('mine'), inbound('latest'), hidden, detached, editor, nestedOutgoing, new Element('div', { class: 'message' }, 'unclassified')] })('tt-read'))
      .toMatchObject({ selection: '', recent: 'latest', source: 'recent' });
  });
  it('extracts the message body without duplicate wrapper text and caps at 4000 characters', () => {
    const message = inbound('Buyer 12:30 ' + 'x'.repeat(4100)).add(new Element('div', { class: 'message-content' }, 'x'.repeat(4100)));
    expect(content({ nodes: [message] })('tt-read').recent).toBe('x'.repeat(4000));
  });
  it('returns none for uncertain direction and non-Alibaba pages', () => {
    expect(content({ nodes: [new Element('div', { class: 'message' }, 'unknown')] })('tt-read')).toMatchObject({ source: 'none', recent: '' });
    expect(content({ nodes: [inbound('private')], url: 'https://example.com/chat' })('tt-read')).toMatchObject({ source: 'none', recent: '' });
  });
  it('distinguishes buyers on one URL path and ignores tracking query parameters', () => {
    const one = content({ url: 'https://message.alibaba.com/chat?buyerId=one&utm_source=a' })('tt-read').conversationKey;
    const two = content({ url: 'https://message.alibaba.com/chat?buyerId=two' })('tt-read').conversationKey;
    expect(one).toBe('https://message.alibaba.com/chat?buyerId=one');
    expect(two).toBe('https://message.alibaba.com/chat?buyerId=two');
  });
  it('uses credible DOM identity and refuses pathname-only identity', () => {
    expect(content({ nodes: [new Element('div', { 'data-thread-id': 'thread-42' })] })('tt-read').conversationKey)
      .toBe('https://message.alibaba.com/chat#data-thread-id=thread-42');
    expect(content()('tt-read').conversationKey).toBeNull();
  });
  it('refuses search inputs and arbitrary editable fields without events', () => {
    for (const active of [new Element('input', { type: 'search' }), new Element('textarea'), new Element('div', { contenteditable: 'true' })]) {
      expect(content({ active })('tt-insert', { text: 'draft' }).ok).toBe(false);
      expect(active.events).toEqual([]);
    }
  });
  it('rejects hidden and detached composers', () => {
    for (const flag of ['hidden', 'isConnected'] as const) {
      const active = new Element('textarea', { 'aria-label': 'Reply message' });
      active[flag] = flag === 'hidden';
      expect(content({ active })('tt-insert', { text: 'draft' }).ok).toBe(false);
      expect(active.events).toEqual([]);
    }
  });
  it('fills a trusted composer with only input/change events and reads its draft', () => {
    const active = new Element('textarea', { 'aria-label': 'Reply message' });
    const dispatch = content({ active });
    expect(dispatch('tt-insert', { text: 'review before sending' })).toMatchObject({ ok: true });
    expect(active.value).toBe('review before sending');
    expect(dispatch('tt-read-draft')).toMatchObject({ text: 'review before sending' });
    expect(active.events).toEqual(['input', 'change']);
  });
  it('trusts a nearby composer container but rejects a search editor inside it', () => {
    const editor = new Element('div', { contenteditable: 'true' });
    const container = new Element('div', { class: 'message-composer' }).add(editor);
    expect(content({ nodes: [container], active: editor })('tt-insert', { text: 'draft' }).ok).toBe(true);
    expect(editor.innerText).toBe('draft');
    const search = new Element('textarea', { 'aria-label': 'Search messages' });
    expect(content({ nodes: [new Element('div', { class: 'message-composer' }).add(search)], active: search })('tt-insert', { text: 'draft' }).ok).toBe(false);
  });
});

async function panel(options: { page?: any; tabId?: number; saved?: any; syncFails?: boolean; insertOk?: boolean } = {}) {
  const elements = new Map<string, Element>();
  const $ = (selector: string) => { if (!elements.has(selector)) elements.set(selector, new Element()); return elements.get(selector)!; };
  $('#channel').value = 'alibaba_rfq';
  const calls: { url: string; body: any }[] = [];
  const writes: any[] = [];
  const copies: string[] = [];
  const pageMessages: string[] = [];
  const tab = { id: options.tabId || 7, url: 'https://message.alibaba.com/chat' };
  const page = options.page || { selection: '', recent: 'Exact buyer request\n36W / IP44', source: 'recent', conversationKey: 'https://message.alibaba.com/chat?buyerId=42' };
  const result = { session_id: 'session-42', run_id: 'run-1', round: 1, extraction: { method: 'rules', language: 'en' },
    change_order: [], quote_options: [], questions: [], replies: { en: { body: 'Draft only', check: { level: 'green', annotations: [] } } } };
  runInNewContext(readFileSync(new URL('../workflow-1/extension/sidepanel.js', import.meta.url), 'utf8'), {
    document: { querySelector: $ }, URL, crypto: { randomUUID: (() => { let n = 0; return () => `capture-${++n}`; })() },
    setTimeout: () => 0, clearTimeout: () => {}, navigator: { clipboard: { writeText: async (text: string) => { copies.push(text); } } },
    fetch: async (url: string, init?: any) => {
      calls.push({ url, body: init?.body ? JSON.parse(init.body) : undefined });
      const ok = !(options.syncFails && url.endsWith('/sync'));
      return { ok, status: ok ? 200 : 503, json: async () => url.endsWith('/health') ? { llm_configured: false } : url.endsWith('/sync') ? {} : url.endsWith('/check') ? { level: 'green', annotations: [] } : result };
    },
    chrome: {
      tabs: { query: async () => [tab], sendMessage: async (_id: number, msg: any) => { pageMessages.push(msg.type); return msg.type === 'tt-read' ? page : { ok: !!options.insertOk }; } },
      scripting: { executeScript: async () => [] },
      storage: { local: { get: async () => options.saved || {}, set: async (value: any) => { writes.push(JSON.parse(JSON.stringify(value))); } } },
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  return { $, calls, copies, writes, page, tab, pageMessages, click: async (id: string) => { const el = $(id); await el.listeners.click({ target: el }); await new Promise((resolve) => setImmediate(resolve)); } };
}

describe('extension panel integration', () => {
  it('previews exact extracted text for editing and sends nothing until analyze', async () => {
    const p = await panel();
    await p.click('#btn-read');
    expect(p.$('#input').value).toBe('Exact buyer request\n36W / IP44');
    expect(p.$('#toast').textContent).toContain('最近');
    expect(p.calls.map((c) => c.url)).toEqual(['http://127.0.0.1:3001/api/workflow1/health']);
    p.$('#input').value = 'edited 30W / IP44';
    await p.click('#btn-analyze');
    expect(p.calls[1]).toMatchObject({ url: 'http://127.0.0.1:3001/api/workflow1/analyze', body: { text: 'edited 30W / IP44', session_id: null } });
    expect(p.calls[2]).toMatchObject({ url: 'http://127.0.0.1:3001/api/workflow1/sync', body: { session_id: 'session-42', run_id: 'run-1' } });
  });
  it('does not reuse another buyer session on the same pathname', async () => {
    const p = await panel({ saved: { sessions: { 'https://message.alibaba.com/chat': 'old-buyer' } } });
    await p.click('#btn-read'); await p.click('#btn-analyze');
    p.page.conversationKey = 'https://message.alibaba.com/chat?buyerId=other';
    await p.click('#btn-analyze');
    expect(p.$('#toast').textContent).toContain('变化');
    await p.click('#btn-read');
    await p.click('#btn-analyze');
    expect(p.calls.filter((c) => c.url.endsWith('/analyze')).map((c) => c.body.session_id)).toEqual([null, null]);
  });
  it('continues the same identified buyer, checks and synchronizes instructions through Node', async () => {
    const p = await panel();
    await p.click('#btn-read'); await p.click('#btn-analyze'); await p.click('#btn-analyze');
    expect(p.calls.filter((c) => c.url.endsWith('/analyze')).map((c) => c.body.session_id)).toEqual([null, 'session-42']);
    await p.click('#btn-check');
    expect(p.calls.at(-1)).toMatchObject({ url: 'http://127.0.0.1:3001/api/workflow1/check', body: { session_id: 'session-42' } });
    p.$('#instruction').value = 'Do not promise delivery';
    await p.click('#btn-instruct');
    expect(p.calls.slice(-2).map((c) => c.url)).toEqual(['http://127.0.0.1:3001/api/workflow1/instruct', 'http://127.0.0.1:3001/api/workflow1/sync']);
  });
  it('requires rereading after a tab switch and copies rather than inserting into another buyer', async () => {
    const p = await panel({ insertOk: true });
    await p.click('#btn-read'); await p.click('#btn-analyze');
    p.tab.id = 8;
    await p.click('#btn-analyze');
    expect(p.calls.filter((c) => c.url.endsWith('/analyze'))).toHaveLength(1);
    await p.click('#btn-insert');
    expect(p.pageMessages).not.toContain('tt-insert');
    expect(p.copies).toEqual(['Draft only']);
  });
  it('uses fresh tab-bound captures when buyer identity is unknown', async () => {
    const p = await panel({ page: { selection: 'buyer', recent: '', source: 'selection', conversationKey: null } });
    await p.click('#btn-read'); await p.click('#btn-analyze'); await p.click('#btn-analyze');
    expect(p.calls.filter((c) => c.url.endsWith('/analyze')).map((c) => c.body.session_id)).toEqual([null, null]);
    expect(Object.keys(p.writes.at(-1).sessions).every((key) => key.includes('tab=7'))).toBe(true);
  });
  it('falls back to clipboard when page refuses insertion', async () => {
    const p = await panel(); p.$('#reply-body').value = 'manual paste';
    await p.click('#btn-insert');
    expect(p.copies).toEqual(['manual paste']);
  });
  it('shows sync failure instead of claiming quality queue completion', async () => {
    const p = await panel({ syncFails: true });
    await p.click('#btn-read'); await p.click('#btn-analyze');
    expect(p.$('#toast').textContent).toContain('同步');
    await p.click('#btn-sync');
    expect(p.calls.filter((c) => c.url.endsWith('/analyze'))).toHaveLength(1);
    expect(p.calls.filter((c) => c.url.endsWith('/sync'))).toHaveLength(2);
  });
  it('supports explicit standalone Python override without duplicate API prefix', async () => {
    const p = await panel({ saved: { backend: 'http://127.0.0.1:8000' } });
    await p.click('#btn-read'); await p.click('#btn-analyze');
    expect(p.calls.map((c) => c.url)).toEqual(['http://127.0.0.1:8000/api/health', 'http://127.0.0.1:8000/api/analyze']);
  });
});

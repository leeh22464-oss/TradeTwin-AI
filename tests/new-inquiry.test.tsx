import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';

const hooks = vi.hoisted(() => ({ values: [] as any[], cursor: 0, effects: [] as (() => any)[], refs: [] as any[], refCursor: 0 }));
vi.mock('react', async (original) => ({ ...await original<typeof import('react')>(),
  useState: (initial: any) => {
    const index = hooks.cursor++;
    if (!(index in hooks.values)) hooks.values[index] = initial;
    return [hooks.values[index], (value: any) => { hooks.values[index] = typeof value === 'function' ? value(hooks.values[index]) : value; }];
  },
  useRef: (initial: any) => { const index = hooks.refCursor++; return hooks.refs[index] ||= { current: initial }; },
  useEffect: (fn: () => any) => { hooks.effects.push(fn); },
}));
vi.mock('react-dom', () => ({ createPortal: (element: ReactElement) => element }));

import NewInquiryDialog from '../src/components/NewInquiryDialog';

function elements(value: any): ReactElement<any>[] {
  if (Array.isArray(value)) return value.flatMap(elements);
  if (!value || typeof value !== 'object') return [];
  return [value, ...elements(value.props?.children)];
}

function hasText(value: any, text: string): boolean {
  if (typeof value === 'string') return value.includes(text);
  if (Array.isArray(value)) return value.some((item) => hasText(item, text));
  return Boolean(value && typeof value === 'object' && hasText(value.props?.children, text));
}

function response(data: unknown, ok = true) {
  return { ok, status: ok ? 200 : 503, json: async () => data };
}

async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function setup(fetcher = vi.fn()) {
  hooks.values = []; hooks.cursor = 0; hooks.effects = []; hooks.refs = []; hooks.refCursor = 0;
  vi.stubGlobal('document', { getElementById: () => null });
  const intervals: Array<() => unknown> = [];
  vi.stubGlobal('setInterval', vi.fn((callback: () => unknown) => { intervals.push(callback); return intervals.length; }));
  vi.stubGlobal('clearInterval', vi.fn());
  vi.stubGlobal('fetch', fetcher);
  const props = { onClose: vi.fn(), onCreate: vi.fn(), onOpenCase: vi.fn(), busy: false };
  const render = () => { hooks.cursor = 0; hooks.refCursor = 0; return elements(NewInquiryDialog(props)); };
  return { props, render, effects: hooks.effects, fetcher, tick: () => intervals.forEach((callback) => callback()) };
}

afterEach(() => { vi.unstubAllGlobals(); });

describe('new inquiry channel intake', () => {
  it('keeps mailbox configuration out of the default email intake view', () => {
    const { render } = setup();
    const tree = render();
    const text = tree.map((element) => typeof element.props.children === 'string' ? element.props.children : '').join(' ');
    expect(text).toContain('邮箱');
    expect(text).toContain('邮箱设置');
    expect(text).toContain('收件箱');
    expect(tree.some((element) => element.props.className?.split(' ').includes('mail-settings-form'))).toBe(false);
  });

  it('opens mailbox configuration as a secondary screen on request', () => {
    const { render } = setup();
    let tree = render();
    const settings = tree.find((element) => element.type === 'button' && hasText(element.props.children, '邮箱设置'));
    expect(settings).toBeDefined();
    settings!.props.onClick();
    tree = render();
    expect(tree.some((element) => element.props.className?.split(' ').includes('mail-settings-screen'))).toBe(true);
    expect(tree.some((element) => element.props.className?.split(' ').includes('mail-settings-form'))).toBe(true);
    expect(tree.some((element) => element.props.id === 'email-intake-panel')).toBe(false);
  });

  it('switches the source panel when the browser plugin channel is selected', () => {
    const { render } = setup();
    const tree = render();
    const plugin = tree.find((element) => element.type === 'button' && element.props['aria-pressed'] === false
      && hasText(element.props.children, '浏览器插件'));
    expect(plugin).toBeDefined();
    plugin!.props.onClick();
    const switched = render();
    expect(switched.some((element) => element.props.id === 'extension-intake-panel')).toBe(true);
    expect(switched.some((element) => element.props.id === 'email-intake-panel')).toBe(false);
  });

  it('refreshes and previews mailbox threads', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(response({ settings: { imap_host: 'imap.example.com', imap_port: 993, user: 'sales@example.com', drafts_folder: '', signature: '', has_password: true }, status: { mode: 'imap', address: 'sales@example.com' } }))
      .mockResolvedValueOnce(response({ status: { mode: 'imap' }, threads: [{ thread_id: 'T-1', subject: 'NL-L request', buyer_name: 'Anna', buyer_addr: 'anna@example.com', message_count: 1, inbound_count: 1, updated_at: '2026-11-01T01:00:00Z', last_message_id: '<m1>', preview: '36W / IP44' }] }))
      .mockResolvedValueOnce(response({ thread_id: 'T-1', subject: 'NL-L request', messages: [{ message_id: '<m1>', from_name: 'Anna', from_email: 'anna@example.com', date: '2026-11-01T01:00:00Z', body_clean: 'Please change to 36W / IP44.' }] }));
    const { render, effects } = setup(fetcher);
    render();
    effects.forEach((effect) => effect());
    await settle();
    let tree = render();
    const refresh = tree.find((element) => element.type === 'button' && hasText(element.props.children, '刷新收件箱'));
    expect(refresh).toBeDefined();
    refresh!.props.onClick();
    await settle();
    tree = render();
    const thread = tree.find((element) => element.type === 'button' && hasText(element.props.children, 'NL-L request'));
    expect(thread).toBeDefined();
    thread!.props.onClick();
    await settle();
    tree = render();
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
      '/api/workflow1/settings/mail', '/api/workflow1/mail/threads?refresh=true', '/api/workflow1/mail/thread/T-1',
    ]);
    expect(tree.some((element) => element.props.id === 'email-thread-preview')).toBe(true);
  });

  it('imports only the selected email thread and opens its synchronized case', async () => {
    const caseRecord = { id: 'T-1', name: 'NL-L request', buyer: 'Anna', channel: 'email', inquiry: 'Please change to 36W / IP44.' };
    const analyze = { session_id: 'T-1', run_id: 'RUN-1', round: 1, channel: 'email', change_order: [], quote_options: [], workflow2: { ok: true }, scope: { market: 'EU', product_scope: 'indoor_fixed_led_luminaire', rule_version: 'r1', evidence_version: 'e1' } };
    const fetcher = vi.fn()
      .mockResolvedValueOnce(response({ settings: { imap_host: 'imap.example.com', imap_port: 993, user: 'sales@example.com', drafts_folder: '', signature: '', has_password: true }, status: { mode: 'imap', address: 'sales@example.com' } }))
      .mockResolvedValueOnce(response({ status: { mode: 'imap' }, threads: [{ thread_id: 'T-1', subject: 'NL-L request', buyer_name: 'Anna', buyer_addr: 'anna@example.com', message_count: 1, inbound_count: 1, updated_at: '2026-11-01T01:00:00Z', last_message_id: '<m1>', preview: '36W / IP44' }] }))
      .mockResolvedValueOnce(response({ thread_id: 'T-1', subject: 'NL-L request', messages: [{ message_id: '<m1>', from_name: 'Anna', from_email: 'anna@example.com', date: '2026-11-01T01:00:00Z', body_clean: 'Please change to 36W / IP44.' }] }))
      .mockResolvedValueOnce(response(analyze))
      .mockResolvedValueOnce(response({ case: caseRecord, replay: false }));
    const { render, effects, props } = setup(fetcher);
    render(); effects.forEach((effect) => effect()); await settle();
    let tree = render();
    tree.find((element) => element.type === 'button' && hasText(element.props.children, '刷新收件箱'))!.props.onClick();
    await settle(); tree = render();
    tree.find((element) => element.type === 'button' && hasText(element.props.children, 'NL-L request'))!.props.onClick();
    await settle(); tree = render();
    const importButton = tree.find((element) => element.type === 'button' && hasText(element.props.children, '导入到案件'));
    expect(importButton).toBeDefined();
    expect(fetcher.mock.calls).toHaveLength(3);
    importButton!.props.onClick(); await settle();
    expect(fetcher.mock.calls.slice(3).map(([url, init]) => [url, init?.body && JSON.parse(init.body)])).toEqual([
      ['/api/workflow1/mail/analyze', { thread_id: 'T-1' }], ['/api/workflow1/sync', analyze],
    ]);
    expect(props.onOpenCase).toHaveBeenCalledWith(caseRecord);
  });

  it('keeps email intake open when analysis or synchronization fails', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(response({ settings: { imap_host: 'imap.example.com', imap_port: 993, user: 'sales@example.com', drafts_folder: '', signature: '', has_password: true }, status: { mode: 'imap', address: 'sales@example.com' } }))
      .mockResolvedValueOnce(response({ status: { mode: 'imap' }, threads: [{ thread_id: 'T-1', subject: 'NL-L request', buyer_name: 'Anna', buyer_addr: 'anna@example.com', message_count: 1, inbound_count: 1, updated_at: '2026-11-01T01:00:00Z', last_message_id: '<m1>', preview: '36W / IP44' }] }))
      .mockResolvedValueOnce(response({ thread_id: 'T-1', subject: 'NL-L request', messages: [{ message_id: '<m1>', from_name: 'Anna', from_email: 'anna@example.com', date: '2026-11-01T01:00:00Z', body_clean: 'Please change to 36W / IP44.' }] }))
      .mockResolvedValueOnce(response({ message: 'workflow unavailable' }, false));
    const { render, effects, props } = setup(fetcher);
    render(); effects.forEach((effect) => effect()); await settle();
    let tree = render();
    tree.find((element) => element.type === 'button' && hasText(element.props.children, '刷新收件箱'))!.props.onClick();
    await settle(); tree = render();
    tree.find((element) => element.type === 'button' && hasText(element.props.children, 'NL-L request'))!.props.onClick();
    await settle(); tree = render();
    tree.find((element) => element.type === 'button' && hasText(element.props.children, '导入到案件'))!.props.onClick();
    await settle();
    expect(props.onOpenCase).not.toHaveBeenCalled();
    expect(props.onClose).not.toHaveBeenCalled();
    expect(render().some((element) => element.props.id === 'email-intake-panel')).toBe(true);
  });

  it('does not show an older email preview after a newer thread was selected', async () => {
    let resolveA!: (value: any) => void;
    let resolveB!: (value: any) => void;
    const fetcher = vi.fn()
      .mockResolvedValueOnce(response({ settings: { imap_host: 'imap.example.com', imap_port: 993, user: 'sales@example.com', drafts_folder: '', signature: '', has_password: true }, status: { mode: 'imap', address: 'sales@example.com' } }))
      .mockResolvedValueOnce(response({ threads: [
        { thread_id: 'A', subject: 'Thread A', updated_at: '2026-11-01T01:00:00Z', preview: 'A' },
        { thread_id: 'B', subject: 'Thread B', updated_at: '2026-11-01T01:00:00Z', preview: 'B' },
      ] }))
      .mockImplementationOnce(() => new Promise((resolve) => { resolveA = resolve; }))
      .mockImplementationOnce(() => new Promise((resolve) => { resolveB = resolve; }));
    const { render, effects } = setup(fetcher);
    render(); effects.forEach((effect) => effect()); await settle();
    let tree = render();
    tree.find((element) => element.type === 'button' && hasText(element.props.children, '刷新收件箱'))!.props.onClick();
    await settle(); tree = render();
    tree.find((element) => element.type === 'button' && hasText(element.props.children, 'Thread A'))!.props.onClick();
    tree.find((element) => element.type === 'button' && hasText(element.props.children, 'Thread B'))!.props.onClick();
    resolveB(response({ thread_id: 'B', subject: 'Thread B', messages: [{ message_id: 'b', body_clean: 'Message B' }] }));
    await settle();
    resolveA(response({ thread_id: 'A', subject: 'Thread A', messages: [{ message_id: 'a', body_clean: 'Message A' }] }));
    await settle(); tree = render();
    expect(hasText(tree, 'Message B')).toBe(true);
    expect(hasText(tree, 'Message A')).toBe(false);
  });

  it('shows how to capture when no extension messages are pending', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(response({ settings: { imap_host: '', imap_port: 993, user: '', drafts_folder: '', signature: '', has_password: false }, status: { mode: 'offline' } }))
      .mockResolvedValueOnce(response({ captures: [] }));
    const { render, effects } = setup(fetcher);
    render(); effects[1]!(); await settle();
    let tree = render();
    tree.find((element) => element.type === 'button' && hasText(element.props.children, '浏览器插件'))!.props.onClick();
    tree = render();
    effects.at(-1)!(); await settle();
    tree = render();
    expect(fetcher.mock.calls.map(([url]) => url)).toContain('/api/extension/captures');
    expect(hasText(tree, '暂无待选内容')).toBe(true);
  });

  it('previews and imports the selected extension capture', async () => {
    const caseRecord = { id: 'extension-session-stable', name: 'RFQ inquiry', buyer: '待确认买家', channel: 'rfq', inquiry: '36W IP44' };
    const fetcher = vi.fn()
      .mockResolvedValueOnce(response({ settings: { imap_host: '', imap_port: 993, user: '', drafts_folder: '', signature: '', has_password: false }, status: { mode: 'offline' } }))
      .mockResolvedValueOnce(response({ captures: [{ id: 'capture-1', sessionId: 'extension-session-stable', sourceUrl: 'https://message.alibaba.com/chat?buyerId=42', createdAt: '2026-11-01T01:00:00Z', expiresAt: '2026-11-01T01:10:00Z', status: 'pending' }] }))
      .mockResolvedValueOnce(response({ id: 'capture-1', sessionId: 'extension-session-stable', text: '36W IP44', sourceUrl: 'https://message.alibaba.com/chat?buyerId=42', createdAt: '2026-11-01T01:00:00Z', expiresAt: '2026-11-01T01:10:00Z', status: 'pending' }))
      .mockResolvedValueOnce(response({ case: caseRecord, replay: false }));
    const { render, effects, props } = setup(fetcher);
    render(); effects[1]!(); await settle();
    let tree = render();
    tree.find((element) => element.type === 'button' && hasText(element.props.children, '浏览器插件'))!.props.onClick();
    tree = render(); effects.at(-1)!(); await settle();
    tree = render();
    tree.find((element) => element.type === 'button' && hasText(element.props.children, 'message.alibaba.com'))!.props.onClick();
    await settle(); tree = render();
    expect(hasText(tree, '36W IP44')).toBe(true);
    expect(tree.some((element) => element.type === 'time')).toBe(true);
    expect(tree.some((element) => element.props.id === 'extension-capture-preview')).toBe(true);
    tree.find((element) => element.type === 'button' && hasText(element.props.children, '导入到案件'))!.props.onClick();
    await settle();
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
      '/api/workflow1/settings/mail', '/api/extension/captures', '/api/extension/captures/capture-1', '/api/extension/captures/capture-1/import',
    ]);
    expect(props.onOpenCase).toHaveBeenCalledWith(caseRecord);
  });

  it('retains the selected extension capture after an import error', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(response({ settings: { imap_host: '', imap_port: 993, user: '', drafts_folder: '', signature: '', has_password: false }, status: { mode: 'offline' } }))
      .mockResolvedValueOnce(response({ captures: [{ id: 'capture-1', sessionId: 'session-1', sourceUrl: 'https://message.alibaba.com/chat', createdAt: '2026-11-01T01:00:00Z', expiresAt: '2026-11-01T01:10:00Z', status: 'pending' }] }))
      .mockResolvedValueOnce(response({ id: 'capture-1', sessionId: 'session-1', text: 'review me', sourceUrl: 'https://message.alibaba.com/chat', createdAt: '2026-11-01T01:00:00Z', expiresAt: '2026-11-01T01:10:00Z', status: 'pending' }))
      .mockResolvedValueOnce(response({ message: 'retry later' }, false));
    const { render, effects, props } = setup(fetcher);
    render(); effects[1]!(); await settle();
    let tree = render();
    tree.find((element) => element.type === 'button' && hasText(element.props.children, '浏览器插件'))!.props.onClick();
    tree = render(); effects.at(-1)!(); await settle();
    tree = render();
    tree.find((element) => element.type === 'button' && hasText(element.props.children, 'message.alibaba.com'))!.props.onClick();
    await settle(); tree = render();
    tree.find((element) => element.type === 'button' && hasText(element.props.children, '导入到案件'))!.props.onClick();
    await settle(); tree = render();
    expect(hasText(tree, 'review me')).toBe(true);
    expect(hasText(tree, 'retry later')).toBe(true);
    expect(props.onOpenCase).not.toHaveBeenCalled();
    expect(props.onClose).not.toHaveBeenCalled();
  });

  it('clears an expired selected capture when the active-channel poll no longer lists it', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(response({ settings: { imap_host: '', imap_port: 993, user: '', drafts_folder: '', signature: '', has_password: false }, status: { mode: 'offline' } }))
      .mockResolvedValueOnce(response({ captures: [{ id: 'capture-1', sessionId: 'session-1', sourceUrl: 'https://message.alibaba.com/chat', createdAt: '2026-11-01T01:00:00Z', expiresAt: '2026-11-01T01:10:00Z', status: 'pending' }] }))
      .mockResolvedValueOnce(response({ id: 'capture-1', sessionId: 'session-1', text: 'expired preview', sourceUrl: 'https://message.alibaba.com/chat', createdAt: '2026-11-01T01:00:00Z', expiresAt: '2026-11-01T01:10:00Z', status: 'pending' }))
      .mockResolvedValueOnce(response({ captures: [{ id: 'capture-2', sessionId: 'session-2', sourceUrl: 'https://message.alibaba.com/chat?buyerId=2', createdAt: '2026-11-01T02:00:00Z', expiresAt: '2026-11-01T02:10:00Z', status: 'pending' }] }));
    const { render, effects, tick } = setup(fetcher);
    render(); effects[1]!(); await settle();
    let tree = render();
    tree.find((element) => element.type === 'button' && hasText(element.props.children, '浏览器插件'))!.props.onClick();
    tree = render(); effects.at(-1)!(); await settle();
    tree = render();
    tree.find((element) => element.type === 'button' && hasText(element.props.children, 'message.alibaba.com'))!.props.onClick();
    await settle(); tree = render();
    expect(hasText(tree, 'expired preview')).toBe(true);
    tick(); await settle(); tree = render();
    expect(hasText(tree, 'expired preview')).toBe(false);
    expect(tree.some((element) => element.props.id === 'extension-capture-preview')).toBe(false);
  });
});

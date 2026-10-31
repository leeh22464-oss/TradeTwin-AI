import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';

const hooks = vi.hoisted(() => ({ values: [] as any[], cursor: 0, effects: [] as (() => any)[], refs: [] as any[], refCursor: 0 }));
vi.mock('react', async (original) => ({ ...await original<typeof import('react')>(),
  useState: (initial: any) => { const index = hooks.cursor++; if (!(index in hooks.values)) hooks.values[index] = initial; return [hooks.values[index], (value: any) => { hooks.values[index] = value; }]; },
  useRef: (initial: any) => { const index = hooks.refCursor++; return hooks.refs[index] ||= { current: initial }; },
  useMemo: (fn: () => any) => fn(), useEffect: (fn: () => any) => { hooks.effects.push(fn); },
}));
import SalesWorkspace from '../src/components/SalesWorkspace';

function elements(value: any): ReactElement<any>[] {
  if (Array.isArray(value)) return value.flatMap(elements);
  if (!value || typeof value !== 'object') return [];
  return [value, ...elements(value.props?.children)];
}

afterEach(() => { vi.unstubAllGlobals(); hooks.values = []; hooks.refs = []; hooks.effects = []; });

describe('sales handoff synchronization gating', () => {
  it('disables both handoff actions while the latest run is syncing or failed and ignores older messages', () => {
    let receive: (event: any) => void = () => {};
    const frame = {};
    vi.stubGlobal('window', { location: { origin: 'http://localhost:5173' }, addEventListener: (_: string, fn: any) => { receive = fn; }, removeEventListener: () => {} });
    vi.stubGlobal('fetch', async () => ({ ok: true, json: async () => ({ ok: true }) }));
    const props = { sessionId: 'session-1', onRefreshCase: vi.fn(), onOpenCase: vi.fn() };
    const render = () => { hooks.cursor = 0; hooks.refCursor = 0; return elements(SalesWorkspace(props)); };
    render(); hooks.refs[0].current = { contentWindow: frame };
    hooks.effects.forEach((fn) => fn());
    const send = (sync_status: string, sync_revision: number, run_id: string) => receive({ origin: 'http://localhost:5173', source: frame,
      data: { type: 'tradetwin:workflow1-result', session_id: 'session-1', shared_case_id: 'session-1', sync_status, sync_revision, run_id } });
    const actionButtons = () => render().filter((element) => element.type === 'button' && String(element.props.className).includes('button-small'));
    send('synced', 1, 'RUN-1');
    expect(actionButtons()).toHaveLength(2);
    expect(actionButtons().every((button) => !button.props.disabled)).toBe(true);
    send('syncing', 2, 'RUN-2');
    expect(actionButtons().every((button) => button.props.disabled)).toBe(true);
    send('synced', 1, 'RUN-1');
    expect(actionButtons().every((button) => button.props.disabled)).toBe(true);
    send('error', 2, 'RUN-2');
    expect(actionButtons().every((button) => button.props.disabled)).toBe(true);
    send('synced', 3, 'RUN-2');
    expect(actionButtons().every((button) => !button.props.disabled)).toBe(true);
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ComponentProps, ReactElement } from 'react';
import type { CaseRecord, ProductConfig } from '../shared/types';

const hooks = vi.hoisted(() => ({ values: [] as any[], cursor: 0, refs: [] as any[], refCursor: 0 }));
vi.mock('react', async (original) => ({ ...await original<typeof import('react')>(),
  useState: (initial: any) => {
    const index = hooks.cursor++;
    if (!(index in hooks.values)) hooks.values[index] = typeof initial === 'function' ? initial() : initial;
    return [hooks.values[index], (value: any) => { hooks.values[index] = typeof value === 'function' ? value(hooks.values[index]) : value; }];
  },
  useRef: (initial: any) => { const index = hooks.refCursor++; return hooks.refs[index] ||= { current: initial }; },
  useEffect: () => {},
  useMemo: (factory: () => unknown) => factory(),
}));
vi.mock('react-dom', () => ({ createPortal: (element: ReactElement) => element }));

import { CommandPalette, Workspace } from '../src/App';

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

function setupHooks() {
  hooks.values = []; hooks.cursor = 0; hooks.refs = []; hooks.refCursor = 0;
  vi.stubGlobal('document', { getElementById: () => null, body: {} });
  return <T,>(component: () => T) => {
    hooks.cursor = 0; hooks.refCursor = 0;
    return component();
  };
}

const baseConfig: ProductConfig = { model: 'NL-L24', powerW: 24, ip: 'IP20', driver: 'DRV-A', material: 'original-material', market: 'DE' };

function setupWorkspace(saveResult: Promise<boolean> = Promise.resolve(true)) {
  const renderComponent = setupHooks();
  let persistedConfig = { ...baseConfig };
  const analysisConfigs: ProductConfig[] = [];
  const caseRecord: CaseRecord = {
    id: 'case-1', name: '待处理询盘', buyer: 'Anna', createdAt: '2026-11-01T00:00:00Z', updatedAt: '2026-11-01T00:00:00Z',
    round: 1, baseConfig: { ...baseConfig }, requestedConfig: { ...baseConfig }, quantity: 100, unitPriceEur: 10,
    channel: 'email', inquiry: '请变更功率', commitment: '', analysis: null, quote: null, messages: [],
  };
  const props: ComponentProps<typeof Workspace> = {
    caseRecord, reports: [], costs: [], busy: null, caseLoading: false,
    onSave: vi.fn(async (patch: any) => {
      const saved = await saveResult;
      if (saved) persistedConfig = { ...patch.config };
      return saved;
    }),
    onAnalyze: () => { analysisConfigs.push({ ...persistedConfig }); },
    onChat: vi.fn(), onQuote: vi.fn(), onEvidence: vi.fn(), onOverride: vi.fn(), onBack: vi.fn(), onDirtyChange: vi.fn(),
  };
  const render = () => elements(renderComponent(() => Workspace(props)));
  const editPower = (value: string) => {
    render().find((element) => element.props.title === '客户参数')!.props.onChange('powerW', value);
  };
  return { props, render, editPower, analysisConfigs };
}

function analyzeButtons(tree: ReactElement<any>[]) {
  return tree.filter((element) => element.type === 'button' && (hasText(element.props.children, '开始推演') || hasText(element.props.children, '推演中')));
}

function setupPalette() {
  const renderComponent = setupHooks();
  const actions: string[] = [];
  const items = [
    { id: 'new', label: '新建询盘', description: '建立案件', icon: null, run: () => actions.push('new') },
    { id: 'queue', label: '案件队列', description: '查看案件', icon: null, run: () => actions.push('queue') },
  ];
  const render = () => elements(renderComponent(() => CommandPalette({ items, onClose: () => actions.push('close') })));
  return { render, actions };
}

// Dispatch the target handler, bubble through the dialog, then perform a button's
// native Enter click unless a handler prevented it. No DOM dependency is needed.
function pressKey(tree: ReactElement<any>[], target: ReactElement<any>, key: string, nativeEvent = { isComposing: false, keyCode: 0 }) {
  const event = { key, nativeEvent, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
  target.props.onKeyDown?.(event);
  const dialog = tree.find((element) => element.props.role === 'dialog');
  if (dialog !== target) dialog?.props.onKeyDown?.(event);
  if (key === 'Enter' && !event.defaultPrevented && !nativeEvent.isComposing) target.props.onClick?.();
  return event;
}

afterEach(() => { vi.unstubAllGlobals(); });

describe('workspace analysis save protection', () => {
  it.each([['top', 0], ['empty state', 1]] as const)('waits for the edited configuration to save from the %s entry', async (_, entry) => {
    let finishSave!: (saved: boolean) => void;
    const workspace = setupWorkspace(new Promise((resolve) => { finishSave = resolve; }));
    workspace.editPower('36');
    const pending = analyzeButtons(workspace.render())[entry]!.props.onClick();
    expect(workspace.analysisConfigs).toEqual([]);
    expect(workspace.props.onSave).toHaveBeenCalledWith({ config: { ...baseConfig, powerW: 36 }, quantity: 100, unitPriceEur: 10 });
    finishSave(true);
    await pending;
    expect(workspace.analysisConfigs).toEqual([{ ...baseConfig, powerW: 36 }]);
    expect(hasText(workspace.render().filter((element) => element.props.className?.split(' ').includes('save-state')), '已保存')).toBe(true);
  });

  it.each([['top', 0], ['empty state', 1]] as const)('preserves the draft and stops analysis after a failed save from the %s entry', async (_, entry) => {
    const workspace = setupWorkspace(Promise.resolve(false));
    workspace.editPower('36');
    await analyzeButtons(workspace.render())[entry]!.props.onClick();
    expect(workspace.analysisConfigs).toEqual([]);
    const tree = workspace.render();
    expect(tree.find((element) => element.props.title === '客户参数')!.props.config.powerW).toBe(36);
    expect(hasText(tree.filter((element) => element.props.className === 'save-state is-dirty'), '未保存')).toBe(true);
  });

  it.each(['save', 'analyze', 'loading'])('disables both analysis entries while %s is in progress', (state) => {
    const workspace = setupWorkspace();
    workspace.props.busy = state === 'loading' ? null : state;
    workspace.props.caseLoading = state === 'loading';
    expect(analyzeButtons(workspace.render()).map((button) => button.props.disabled)).toEqual([true, true]);
  });
});

describe('command palette keyboard actions', () => {
  it('runs the highlighted command when Enter is pressed in the search field', () => {
    const palette = setupPalette();
    let tree = palette.render();
    pressKey(tree, tree.find((element) => element.type === 'input')!, 'ArrowDown');
    tree = palette.render();
    pressKey(tree, tree.find((element) => element.type === 'input')!, 'Enter');
    expect(palette.actions).toEqual(['close', 'queue']);
  });

  it('keeps native Enter on the close button from running a command', () => {
    const palette = setupPalette();
    const tree = palette.render();
    const close = tree.find((element) => element.props.label === '关闭快捷命令')!;
    const event = pressKey(tree, close, 'Enter');
    expect(event.defaultPrevented).toBe(false);
    expect(palette.actions).toEqual(['close']);
  });

  it('runs the focused result with native Enter even when another result is highlighted', () => {
    const palette = setupPalette();
    const tree = palette.render();
    const queue = tree.find((element) => element.props.role === 'option' && hasText(element.props.children, '案件队列'))!;
    const event = pressKey(tree, queue, 'Enter');
    expect(event.defaultPrevented).toBe(false);
    expect(palette.actions).toEqual(['close', 'queue']);
  });

  it('does not intercept arrow keys on a result button', () => {
    const palette = setupPalette();
    const tree = palette.render();
    const queue = tree.find((element) => element.props.role === 'option' && hasText(element.props.children, '案件队列'))!;
    expect(pressKey(tree, queue, 'ArrowDown').defaultPrevented).toBe(false);
    expect(palette.actions).toEqual([]);
    expect(hasText(palette.render().find((element) => element.props.role === 'option' && element.props['aria-selected']), '新建询盘')).toBe(true);
  });

  it.each([
    { isComposing: true, keyCode: 0 },
    { isComposing: false, keyCode: 229 },
  ])('does not select a command during IME composition: %j', (nativeEvent) => {
    const palette = setupPalette();
    const tree = palette.render();
    const input = tree.find((element) => element.type === 'input')!;
    expect(pressKey(tree, input, 'ArrowDown', nativeEvent).defaultPrevented).toBe(false);
    expect(pressKey(tree, input, 'Enter', nativeEvent).defaultPrevented).toBe(false);
    expect(palette.actions).toEqual([]);
    expect(hasText(palette.render().find((element) => element.props.role === 'option' && element.props['aria-selected']), '新建询盘')).toBe(true);
  });
});

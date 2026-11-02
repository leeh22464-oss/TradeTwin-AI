import { describe, expect, it } from 'vitest';
import { filterCommandItems, isCommandPaletteShortcut, type CommandPaletteItem } from '../src/commandPalette';

const items: CommandPaletteItem[] = [
  { id: 'queue', label: '案件队列', keywords: ['询盘', '首页'] },
  { id: 'evidence', label: '证据库', keywords: ['报告', '核验'] },
  { id: 'case-1', label: 'Nordlicht GmbH · NL-36W', keywords: ['德国', '36w', '买家'] },
];

describe('command palette search', () => {
  it('matches case labels and keywords without case or whitespace sensitivity', () => {
    expect(filterCommandItems(items, ' 36W ')).toEqual([items[2]]);
    expect(filterCommandItems(items, '核验')).toEqual([items[1]]);
  });

  it('returns no unrelated commands and caps the unfiltered list', () => {
    expect(filterCommandItems(items, '不存在')).toEqual([]);
    expect(filterCommandItems([...items, ...items, ...items], '')).toHaveLength(8);
  });

  it('recognizes Ctrl/Cmd+K without stealing modified shortcuts', () => {
    expect(isCommandPaletteShortcut({ key: 'k', ctrlKey: true, metaKey: false, altKey: false })).toBe(true);
    expect(isCommandPaletteShortcut({ key: 'K', ctrlKey: false, metaKey: true, altKey: false })).toBe(true);
    expect(isCommandPaletteShortcut({ key: 'k', ctrlKey: false, metaKey: false, altKey: false })).toBe(false);
    expect(isCommandPaletteShortcut({ key: 'k', ctrlKey: true, metaKey: false, altKey: true })).toBe(false);
  });
});

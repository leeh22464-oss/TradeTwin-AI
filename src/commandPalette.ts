export interface CommandPaletteItem {
  id: string;
  label: string;
  keywords?: string[];
}

export function filterCommandItems<T extends CommandPaletteItem>(items: readonly T[], query: string, limit = 8): T[] {
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return items.slice(0, limit);
  return items.filter((item) => {
    const searchable = [item.label, ...(item.keywords ?? [])].join(' ').toLocaleLowerCase();
    return terms.every((term) => searchable.includes(term));
  }).slice(0, limit);
}

export function isCommandPaletteShortcut(event: Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'altKey'>): boolean {
  return (event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLocaleLowerCase() === 'k';
}

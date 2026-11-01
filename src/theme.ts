export type Theme = 'light' | 'dark';

export function resolveTheme(stored: string | null): Theme {
  if (stored === 'dark' || stored === 'light') return stored;
  return 'light';
}

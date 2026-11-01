export type PrimaryNavigationId = 'workspace' | 'evidence' | 'knowledge';

export const primaryNavigation: Array<{ id: PrimaryNavigationId; label: string }> = [
  { id: 'workspace', label: '询盘工作台' },
  { id: 'evidence', label: '证据库' },
  { id: 'knowledge', label: '知识与规则' },
];

export function getViewTitle(view: 'queue' | 'workspace' | 'sales' | 'evidence' | 'knowledge' | 'audit' | 'settings'): string {
  if (view === 'queue' || view === 'workspace' || view === 'sales') return '询盘工作台';
  if (view === 'evidence') return '证据库';
  if (view === 'knowledge') return '知识与规则';
  if (view === 'audit') return '审计记录';
  return '接入设置';
}

import { describe, expect, it } from 'vitest';
import { getViewTitle, primaryNavigation } from './navigation';

describe('canonical inquiry workspace navigation', () => {
  it('uses one shared name for the queue and inquiry detail', () => {
    expect(getViewTitle('queue')).toBe('询盘工作台');
    expect(getViewTitle('workspace')).toBe('询盘工作台');
  });

  it('does not expose workflow one as a separate top-level destination', () => {
    expect(primaryNavigation.map((item) => item.id)).not.toContain('sales');
    expect(primaryNavigation.map((item) => item.label)).toContain('询盘工作台');
  });
});

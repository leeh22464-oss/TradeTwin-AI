import { describe, expect, it } from 'vitest';
import type { CaseRecord, ProductConfig } from '../shared/types';
import { getQueueOverview } from '../src/queueUtils';
import { resolveTheme } from '../src/theme';

const config: ProductConfig = { model: 'NL-L', powerW: 24, ip: 'IP20', driver: 'DRV-A', material: 'original-material', market: 'DE' };

function makeCase(id: string, patch: Partial<CaseRecord> = {}): CaseRecord {
  return {
    id, name: id, buyer: 'Buyer', createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z', round: 1,
    baseConfig: config, requestedConfig: config, quantity: 10, unitPriceEur: 20, channel: 'email', inquiry: '', commitment: '',
    analysis: null, quote: null, messages: [], ...patch,
  };
}

describe('dashboard overview derivation', () => {
  it('counts each queue state and reply draft from the same case records', () => {
    const cases = [
      makeCase('pending'),
      makeCase('review', { analysis: { reviewCount: 1, findings: [{ status: 'review' }, { status: 'retest', feeEur: 900 }], requiredTests: [] } as any }),
      makeCase('ready', { analysis: { reviewCount: 0, findings: [], requiredTests: [] } as any, workflow1Result: { replies: { en: { body: 'Draft' } } } }),
    ];

    expect(getQueueOverview(cases)).toEqual({
      total: 3, pendingAnalysis: 1, needsReview: 1, withRetest: 1, ready: 1, analysed: 2, replyDrafts: 1,
      attention: 2,
    });
  });
});

describe('theme preference', () => {
  it('restores a saved mode and defaults to the light dashboard', () => {
    expect(resolveTheme('dark')).toBe('dark');
    expect(resolveTheme('light')).toBe('light');
    expect(resolveTheme(null)).toBe('light');
    expect(resolveTheme('unknown')).toBe('light');
  });
});

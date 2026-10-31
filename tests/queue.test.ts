import { describe, expect, it } from 'vitest';
import type { AnalysisResult, CaseRecord, Finding, ProductConfig } from '../shared/types';
import { analyzeChange } from '../server/engine';
import { BASE_CONFIG, seedReports } from '../server/seed';
import {
  filterCases, getConfigChanges, getQueueCommercial, getQueueStatus, sortCases, summarizeConfigChanges,
} from '../src/queueUtils';

const baseConfig: ProductConfig = { model: 'NL-L', powerW: 24, ip: 'IP20', driver: 'DRV-A', material: 'original-material', market: 'DE' };

function makeCase(patch: Partial<CaseRecord> = {}): CaseRecord {
  return {
    id: patch.id || 'case-1', name: patch.name || '德国变更', buyer: patch.buyer || 'Nordlicht GmbH',
    createdAt: patch.createdAt || '2026-10-01T00:00:00.000Z', updatedAt: patch.updatedAt || '2026-10-02T00:00:00.000Z',
    round: patch.round || 1, baseConfig: patch.baseConfig || baseConfig,
    requestedConfig: patch.requestedConfig || baseConfig, quantity: patch.quantity || 100, unitPriceEur: patch.unitPriceEur || 20,
    channel: patch.channel || 'email', inquiry: patch.inquiry || '请确认德国买家配置', commitment: patch.commitment || '',
    analysis: patch.analysis === undefined ? null : patch.analysis, quote: patch.quote === undefined ? null : patch.quote,
    messages: patch.messages || [],
  };
}

function finding(status: Finding['status'], feeEur: number | null = null): Finding {
  return { id: `${status}-${feeEur ?? 'unknown'}`, itemId: status, title: status, category: 'compliance', status, reason: 'fixture', ruleIds: ['R-TEST'], evidence: [], feeEur, days: feeEur === null ? null : 5 };
}

function analysis(patch: Partial<AnalysisResult> = {}): AnalysisResult {
  return {
    id: patch.id || 'analysis-1', ruleVersion: 'rules-test', config: baseConfig, findings: patch.findings || [], requiredTests: patch.requiredTests || [], reusedTests: [], documentUpdates: [], reviewCount: patch.reviewCount ?? 0, totalCostEur: patch.totalCostEur ?? 0, leadTimeDays: patch.leadTimeDays === undefined ? 0 : patch.leadTimeDays, canQuote: patch.canQuote ?? true, confidence: .9, warnings: patch.warnings || [], alternatives: [], calculation: { parallelDays: 0, documentationDays: 0, formula: '0' },
  };
}

describe('case queue derivation', () => {
  it('counts workflow-one reply drafts in the replied queue without a legacy Node quote', () => {
    const record = { ...makeCase(), workflow1Result: { replies: { en: { body: 'Please confirm the IP requirement.' } } } };
    expect(getQueueStatus(record).hasReply).toBe(true);
    expect(filterCases([record], '', ['replied'])).toHaveLength(1);
  });

  it('shows a pending workflow-one synchronization as review even when quality totals are known', () => {
    const record = { ...makeCase({ analysis: analysis() }), workflow1QuoteReady: false, workflow1Result: { mode: 'pending_check' } };
    expect(getQueueStatus(record).hasReview).toBe(true);
    expect(getQueueCommercial(record).isUnknown).toBe(true);
  });
  it('derives pending state from missing analysis without claiming a completed analysis', () => {
    const status = getQueueStatus(makeCase());
    expect(status.key).toBe('unanalysed');
    expect(status.label).toBe('待推演');
    expect(status.hasAnalysis).toBe(false);
    expect(status.description).toBe('待推演');
  });

  it('keeps a warning/review case as unknown even when the backend total is zero', () => {
    const record = makeCase({ analysis: analysis({ findings: [finding('review', 900)], reviewCount: 1, totalCostEur: 0, leadTimeDays: null, canQuote: false }) });
    const commercial = getQueueCommercial(record);
    expect(commercial.isUnknown).toBe(true);
    expect(commercial.feeLabel).toBe('待核验');
    expect(commercial.totalFeeEur).toBeNull();
    expect(commercial.knownFeeEur).toBe(900);
    expect(commercial.sortFeeEur).toBeNull();
    expect(commercial.knownFeeLabel).toContain('900');
  });

  it('does not turn the normal synthetic-data warning into an unknown amount', () => {
    const retestAnalysis = analyzeChange({ ...BASE_CONFIG, powerW: 36, ip: 'IP44' }, seedReports);
    const retestSummary = getQueueCommercial(makeCase({ analysis: retestAnalysis }));
    expect(retestSummary.feeLabel).toContain('2.100');
    expect(retestSummary.isUnknown).toBe(false);
    const zeroAnalysis = analyzeChange(BASE_CONFIG, seedReports);
    const zeroSummary = getQueueCommercial(makeCase({ analysis: zeroAnalysis }));
    expect(zeroSummary.feeLabel).toContain('0');
    expect(zeroSummary.isUnknown).toBe(false);
  });

  it('sorts unknown fees last in both directions while keeping a confirmed zero fee sortable', () => {
    const zero = makeCase({ id: 'zero', analysis: analysis({ totalCostEur: 0, leadTimeDays: 0, canQuote: true }) });
    const known = makeCase({ id: 'known', analysis: analysis({ totalCostEur: 900, leadTimeDays: 5, canQuote: true }) });
    const unknown = makeCase({ id: 'unknown', analysis: analysis({ totalCostEur: 0, leadTimeDays: null, canQuote: false }) });
    expect(sortCases([unknown, known, zero], 'fee-asc').map((item) => item.id)).toEqual(['zero', 'known', 'unknown']);
    expect(sortCases([unknown, known, zero], 'fee-desc').map((item) => item.id)).toEqual(['known', 'zero', 'unknown']);
  });

  it('combines filters and searches Chinese customer, model, and buyer wording', () => {
    const reviewRetest = makeCase({ id: 'review', buyer: '莱茵买家', requestedConfig: { ...baseConfig, powerW: 36, ip: 'IP44' }, inquiry: '请改为 36W IP44', analysis: analysis({ findings: [finding('review'), finding('retest', 2100)], reviewCount: 1, requiredTests: ['ip'], canQuote: false }) });
    const replied = makeCase({ id: 'replied', buyer: 'Nordlicht GmbH', quote: { id: 'quote-1', channel: 'email', en: '', de: '', internal: { sales: [], quality: [], procurement: [] }, modelMode: 'demo', modelName: 'local', warnings: [], generatedAt: '2026-10-03T00:00:00.000Z' } });
    const pending = makeCase({ id: 'pending', buyer: '另一客户', inquiry: '询问 IP20', analysis: null });
    expect(filterCases([reviewRetest, replied, pending], '36w', ['review', 'retest']).map((item) => item.id)).toEqual(['review']);
    expect(filterCases([reviewRetest, replied, pending], '莱茵 NL-L', []).map((item) => item.id)).toEqual(['review']);
    expect(filterCases([reviewRetest, replied, pending], '莱茵买家', []).map((item) => item.id)).toEqual(['review']);
    expect(filterCases([reviewRetest, replied, pending], '询问 ip20', ['unanalysed']).map((item) => item.id)).toEqual(['pending']);
    expect(filterCases([reviewRetest, replied, pending], '', ['replied']).map((item) => item.id)).toEqual(['replied']);
  });

  it('summarizes only real parameter differences and labels unknown values explicitly', () => {
    const unchangedPower = makeCase({ baseConfig: { ...baseConfig, powerW: 24 }, requestedConfig: { ...baseConfig, powerW: 24, ip: 'IP44', driver: null } });
    const changes = getConfigChanges(unchangedPower);
    expect(changes.map((change) => change.key)).toEqual(['ip', 'driver']);
    expect(summarizeConfigChanges(unchangedPower)).toEqual(['防护等级 IP20 → IP44', '驱动 DRV-A → 未知']);
    expect(summarizeConfigChanges(unchangedPower).join(' ')).not.toContain('24W → 36W');
  });
});

import { describe, expect, it } from 'vitest';
import type { AnalysisResult, Alternative, ProductConfig } from '../shared/types.js';
import { BASE_CONFIG } from '../server/seed.js';
import { parseInquiryChange } from '../server/inquiry.js';

const current: ProductConfig = { ...BASE_CONFIG };

function previousWith(powerW: number, ip = 'IP44'): AnalysisResult {
  const alternative = (id: 'A' | 'B', power: number, protection: string): Alternative => ({
    id,
    label: `方案 ${id}`,
    config: { ...current, powerW: power, ip: protection },
    totalCostEur: 900,
    leadTimeDays: 7,
    requiredTests: ['ip'],
    summary: '演示方案',
  });
  return {
    id: 'analysis-test', ruleVersion: 'test', config: { ...current, powerW, ip }, findings: [],
    requiredTests: [], reusedTests: [], documentUpdates: [], reviewCount: 0, totalCostEur: 0,
    leadTimeDays: 0, canQuote: true, confidence: 0.9, warnings: [],
    alternatives: [alternative('A', 30, 'IP44'), alternative('B', 36, 'IP44')],
    calculation: { parallelDays: 0, documentationDays: 0, formula: '0' },
  };
}

describe('deterministic inquiry parsing', () => {
  it.each([
    ['36 Watt statt 24 Watt（德语）', 36],
    ['36 Watts statt 24 Watts（德语复数）', 36],
    ['36 W statt 24 W', 36],
    ['36W instead of the current 24W', 36],
    ['replace24Wwith36W', 36],
    ['from24to36', 36],
    ['用36W替换24W', 36],
    ['24W改成36W', 36],
  ])('takes the target power from an explicit direction: %s', (message, expected) => {
    expect(parseInquiryChange(message, current).config.powerW).toBe(expected);
  });

  it.each([
    ['IP44 statt IP20', 'IP44'],
    ['replace IP20 with IP44', 'IP44'],
    ['DRV-B instead of DRV-A', 'DRV-B'],
    ['replace DRV-A with DRV-B', 'DRV-B'],
  ])('takes the target non-power parameter from an explicit direction: %s', (message, expected) => {
    const parsed = parseInquiryChange(message, current);
    expect(message.includes('DRV') ? parsed.config.driver : parsed.config.ip).toBe(expected);
  });

  it('does not pick the last of several undirected power values', () => {
    const parsed = parseInquiryChange('报告写 24W，客户资料写 36W，请先核对。', current);
    expect(parsed.config.powerW).toBe(current.powerW);
    expect(parsed.summary).toContain('多个候选参数');
  });

  it('does not apply a negated parameter direction and does not force review', () => {
    for (const message of ['do not change to 36W', '不要把24W改成36W', '不要把 24W 替换成 36W']) {
      const parsed = parseInquiryChange(message, current);
      expect(parsed.config.powerW, message).toBe(current.powerW);
      expect(parsed.requiresReview, message).toBeUndefined();
    }
  });

  it('flags multiple explicit directions instead of taking the first', () => {
    const parsed = parseInquiryChange('36W statt 24W，然后 45W statt 36W，请确认。', current);
    expect(parsed.config.powerW).toBe(current.powerW);
    expect(parsed.requiresReview).toBe(true);
  });

  it('selects the explicitly taken option B instead of an earlier mention of A', () => {
    const parsed = parseInquiryChange('Option A is too expensive, we take option B.', current, previousWith(36));
    expect(parsed.config.powerW).toBe(36);
    expect(parsed.config.ip).toBe('IP44');
  });

  it('ignores a negated option but still honors an affirmative later option', () => {
    const parsed = parseInquiryChange('We do not choose option A; we take option B.', current, previousWith(36));
    expect(parsed.config.powerW).toBe(36);
    expect(parsed.requiresReview).toBeUndefined();
  });

  it('does not treat a mentioned or negated option as a selection', () => {
    const mentioned = parseInquiryChange('Option A is too expensive.', current, previousWith(36));
    expect(mentioned.config).toEqual(current);
    const negated = parseInquiryChange('不需要 36W，先保留当前配置。', current, previousWith(36));
    expect(negated.config.powerW).toBe(current.powerW);
    expect(negated.requiresReview).toBeUndefined();
  });

  it('does not invent fallback option configurations without previous alternatives', () => {
    const parsed = parseInquiryChange('客户选择 option B。', current, null);
    expect(parsed.config).toEqual(current);
    expect(parsed.summary).toContain('没有可用的方案明细');
    expect(parsed.requiresReview).toBe(true);
  });

  it('does not change material for a future confirmation note', () => {
    const parsed = parseInquiryChange('material to be confirmed later', current);
    expect(parsed.config.material).toBe(current.material);
  });

  it('does not apply negated or unknown material changes', () => {
    const negated = parseInquiryChange('do not change material to aluminium', current);
    expect(negated.config.material).toBe(current.material);
    expect(negated.requiresReview).toBeUndefined();
    const unknown = parseInquiryChange('材料改为未知', current);
    expect(unknown.config.material).toBe(current.material);
    expect(unknown.requiresReview).toBe(true);
  });

  it('does not change market for German instructions, but does for an explicit destination', () => {
    const euCurrent = { ...current, market: 'EU' };
    expect(parseInquiryChange('Please include German instructions.', euCurrent).config.market).toBe('EU');
    expect(parseInquiryChange('Please ship to Germany.', euCurrent).config.market).toBe('DE');
    expect(parseInquiryChange('目标市场：德国', euCurrent).config.market).toBe('DE');
  });

  it('uses a clear final target market and reviews an unresolved market conflict', () => {
    const fr = parseInquiryChange('ship to Germany but target market is France', current);
    expect(fr.config.market).toBe('FR');
    const unresolved = parseInquiryChange('target market is Germany but ship to France', current);
    expect(unresolved.config.market).toBe(current.market);
    expect(unresolved.requiresReview).toBe(true);
  });

  it('does not take the first direction when later text reverses or rejects it', () => {
    for (const message of [
      '36W instead of 24W, but do not change to 36W',
      'change to 36W but keep current 24W',
      'from 24W to 36W then revert to 24W',
    ]) {
      const parsed = parseInquiryChange(message, current);
      expect(parsed.config.powerW, message).toBe(current.powerW);
      expect(parsed.requiresReview, message).toBe(true);
    }
  });

  it('parses an explicit material change and delivery hold', () => {
    const parsed = parseInquiryChange('将材料改为 aluminium-v2，暂不承诺具体交期。', current);
    expect(parsed.config.material).toBe('aluminium-v2');
    expect(parsed.withholdDelivery).toBe(true);
  });
});

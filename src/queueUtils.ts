import type { CaseRecord, ProductConfig } from '../shared/types';

export type QueueFilter = 'unanalysed' | 'review' | 'retest' | 'replied';
export type QueueSort = 'updated-desc' | 'updated-asc' | 'customer-asc' | 'fee-asc' | 'fee-desc';

export type ConfigChangeKey = 'model' | 'powerW' | 'ip' | 'driver' | 'material' | 'market';

export interface ConfigChange {
  key: ConfigChangeKey;
  label: string;
  from: string;
  to: string;
}

export interface QueueCaseStatus {
  key: 'unanalysed' | 'review' | 'retest' | 'ready';
  label: '待推演' | '待核验' | '含补测' | '已推演';
  description: string;
  hasAnalysis: boolean;
  hasReview: boolean;
  hasRetest: boolean;
  hasReply: boolean;
  reviewCount: number;
  retestCount: number;
}

export interface QueueCommercialSummary {
  isUnknown: boolean;
  totalFeeEur: number | null;
  knownFeeEur: number | null;
  leadTimeDays: number | null;
  feeLabel: string;
  leadTimeLabel: string;
  knownFeeLabel: string | null;
  note: string;
  commitmentLabel: string | null;
  sortFeeEur: number | null;
}

const CONFIG_FIELDS: Array<{ key: ConfigChangeKey; label: string }> = [
  { key: 'model', label: '型号 / 系列' },
  { key: 'powerW', label: '功率' },
  { key: 'ip', label: '防护等级' },
  { key: 'driver', label: '驱动' },
  { key: 'material', label: '材料' },
  { key: 'market', label: '市场' },
];

function normalizedValue(value: unknown): string | number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed ? trimmed : null;
  }
  return typeof value === 'number' ? value : String(value);
}

function displayConfigValue(key: ConfigChangeKey, value: unknown): string {
  const normalized = normalizedValue(value);
  if (normalized === null) return '未知';
  return key === 'powerW' ? `${normalized}W` : String(normalized);
}

function valuesEqual(left: unknown, right: unknown): boolean {
  const normalizedLeft = normalizedValue(left);
  const normalizedRight = normalizedValue(right);
  return normalizedLeft === normalizedRight;
}

/**
 * Returns only actual base/requested differences. Empty and null both mean
 * unknown, so a missing value never creates a made-up change.
 */
export function getConfigChanges(caseRecord: CaseRecord): ConfigChange[] {
  const base = caseRecord.baseConfig ?? ({} as ProductConfig);
  const requested = caseRecord.requestedConfig ?? ({} as ProductConfig);
  return CONFIG_FIELDS.flatMap(({ key, label }) => {
    if (valuesEqual(base[key], requested[key])) return [];
    return [{ key, label, from: displayConfigValue(key, base[key]), to: displayConfigValue(key, requested[key]) }];
  });
}

export function formatConfigChange(change: ConfigChange): string {
  return `${change.label} ${change.from} → ${change.to}`;
}

export function summarizeConfigChanges(caseRecord: CaseRecord): string[] {
  return getConfigChanges(caseRecord).map(formatConfigChange);
}

export function getQueueStatus(caseRecord: CaseRecord): QueueCaseStatus {
  const analysis = caseRecord.analysis;
  const hasReply = Boolean(caseRecord.quote);
  if (!analysis) {
    return {
      key: 'unanalysed',
      label: '待推演',
      description: '待推演',
      hasAnalysis: false,
      hasReview: false,
      hasRetest: false,
      hasReply,
      reviewCount: 0,
      retestCount: 0,
    };
  }

  const reviewCount = analysis.findings.filter((finding) => finding.status === 'review' || finding.status === 'warning').length;
  const hasReview = analysis.reviewCount > 0 || reviewCount > 0;
  const retestCount = analysis.findings.filter((finding) => finding.status === 'retest').length;
  const hasRetest = retestCount > 0 || analysis.requiredTests.length > 0;
  if (hasReview) {
    const effectiveReviewCount = Math.max(analysis.reviewCount, reviewCount);
    return { key: 'review', label: '待核验', description: effectiveReviewCount > 0 ? `${effectiveReviewCount} 项需人工核验` : '存在承诺风险，待核验', hasAnalysis: true, hasReview, hasRetest, hasReply, reviewCount: effectiveReviewCount, retestCount };
  }
  if (hasRetest) {
    return { key: 'retest', label: '含补测', description: `${retestCount || analysis.requiredTests.length} 项补测`, hasAnalysis: true, hasReview, hasRetest, hasReply, reviewCount, retestCount: retestCount || analysis.requiredTests.length };
  }
  return { key: 'ready', label: '已推演', description: '规则已计算', hasAnalysis: true, hasReview, hasRetest, hasReply, reviewCount, retestCount };
}

function hasUnknownFeeCondition(caseRecord: CaseRecord): boolean {
  const analysis = caseRecord.analysis;
  if (!analysis) return true;
  return analysis.reviewCount > 0
    || analysis.findings.some((finding) => finding.status === 'review' || finding.status === 'warning')
    || analysis.leadTimeDays === null
    || !analysis.canQuote
    || !Number.isFinite(analysis.totalCostEur)
    || analysis.findings.some((finding) => finding.status === 'retest' && finding.feeEur === null);
}

/**
 * Keeps unknown amounts explicit. A known subtotal is informational only and
 * is never used as the total or as a zero fallback.
 */
export function getQueueCommercial(caseRecord: CaseRecord): QueueCommercialSummary {
  const analysis = caseRecord.analysis;
  if (!analysis) {
    return {
      isUnknown: true,
      totalFeeEur: null,
      knownFeeEur: null,
      leadTimeDays: null,
      feeLabel: '待推演',
      leadTimeLabel: '等待推演',
      knownFeeLabel: null,
      note: '尚未运行规则推演',
      commitmentLabel: caseRecord.commitment?.trim() || null,
      sortFeeEur: null,
    };
  }

  const knownFees = analysis.findings
    .map((finding) => finding.feeEur)
    .filter((fee): fee is number => typeof fee === 'number' && Number.isFinite(fee));
  const knownFeeEur = knownFees.length ? knownFees.reduce((sum, fee) => sum + fee, 0) : null;
  const unknown = hasUnknownFeeCondition(caseRecord);
  if (unknown) {
    return {
      isUnknown: true,
      totalFeeEur: null,
      knownFeeEur,
      leadTimeDays: analysis.leadTimeDays,
      feeLabel: '待核验',
      leadTimeLabel: analysis.leadTimeDays === null ? '交期待核验' : `+${analysis.leadTimeDays} 工作日`,
      knownFeeLabel: knownFeeEur !== null && knownFeeEur > 0 ? `已知费用小计 €${knownFeeEur.toLocaleString('de-DE')}` : null,
      note: '示意费用，需检测机构确认',
      commitmentLabel: caseRecord.commitment?.trim() || null,
      sortFeeEur: null,
    };
  }
  return {
    isUnknown: false,
    totalFeeEur: analysis.totalCostEur,
    knownFeeEur,
    leadTimeDays: analysis.leadTimeDays,
    feeLabel: `€${analysis.totalCostEur.toLocaleString('de-DE')}`,
    leadTimeLabel: `+${analysis.leadTimeDays} 工作日`,
    knownFeeLabel: null,
    note: '示意费用，排期待机构确认',
    commitmentLabel: caseRecord.commitment?.trim() || null,
    sortFeeEur: analysis.totalCostEur,
  };
}

function searchFields(caseRecord: CaseRecord): string[] {
  const config = caseRecord.requestedConfig ?? {} as ProductConfig;
  return [
    caseRecord.name,
    caseRecord.buyer,
    caseRecord.inquiry,
    config.model,
    config.powerW,
    config.powerW === null || config.powerW === undefined ? null : `${config.powerW}W`,
    config.ip,
    config.driver,
    config.material,
    config.market,
  ].filter((value) => value !== null && value !== undefined).map((value) => String(value).toLocaleLowerCase('zh-CN'));
}

export function caseMatchesSearch(caseRecord: CaseRecord, query: string): boolean {
  const normalizedQuery = query.toLocaleLowerCase('zh-CN').trim();
  if (!normalizedQuery) return true;
  const fields = searchFields(caseRecord);
  const tokens = normalizedQuery.split(/\s+/).filter(Boolean);
  return tokens.every((token) => fields.some((field) => field.includes(token)));
}

export function caseMatchesFilter(caseRecord: CaseRecord, filter: QueueFilter): boolean {
  const status = getQueueStatus(caseRecord);
  switch (filter) {
    case 'unanalysed': return !status.hasAnalysis;
    case 'review': return status.hasReview;
    case 'retest': return status.hasRetest;
    case 'replied': return status.hasReply;
    default: return true;
  }
}

export function filterCases(caseRecords: CaseRecord[], query: string, filters: Iterable<QueueFilter>): CaseRecord[] {
  const selected = [...filters];
  return caseRecords.filter((caseRecord) => caseMatchesSearch(caseRecord, query) && selected.every((filter) => caseMatchesFilter(caseRecord, filter)));
}

function timestamp(value: string): number {
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
}

export function sortCases(caseRecords: CaseRecord[], sort: QueueSort): CaseRecord[] {
  return [...caseRecords].sort((left, right) => {
    if (sort === 'customer-asc') {
      const byCustomer = left.buyer.localeCompare(right.buyer, 'zh-CN');
      return byCustomer || timestamp(right.updatedAt) - timestamp(left.updatedAt);
    }
    if (sort === 'fee-asc' || sort === 'fee-desc') {
      const leftFee = getQueueCommercial(left).sortFeeEur;
      const rightFee = getQueueCommercial(right).sortFeeEur;
      if (leftFee === null && rightFee !== null) return 1;
      if (leftFee !== null && rightFee === null) return -1;
      if (leftFee !== null && rightFee !== null && leftFee !== rightFee) return sort === 'fee-asc' ? leftFee - rightFee : rightFee - leftFee;
    }
    const updated = timestamp(right.updatedAt) - timestamp(left.updatedAt);
    return sort === 'updated-asc' ? -updated : updated;
  });
}

export function formatQueueDate(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return '时间待核验';
  return parsed.toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' });
}

export function paginate<T>(items: T[], page: number, pageSize: number): { items: T[]; page: number; pageCount: number } {
  const safeSize = pageSize > 0 ? pageSize : 10;
  const pageCount = Math.max(1, Math.ceil(items.length / safeSize));
  const safePage = Math.min(Math.max(page, 1), pageCount);
  return { items: items.slice((safePage - 1) * safeSize, safePage * safeSize), page: safePage, pageCount };
}

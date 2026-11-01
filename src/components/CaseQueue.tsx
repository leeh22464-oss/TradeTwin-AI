import { useEffect, useMemo } from 'react';
import {
  AlertTriangle, CheckCircle2, ChevronLeft, ChevronRight, CircleDashed, Columns3, FolderOpen,
  Filter, ListFilter, Plus, RefreshCw, RotateCcw, Search,
} from 'lucide-react';
import type { CaseRecord } from '../../shared/types';
import {
  filterCases, formatConfigChange, formatQueueDate, getConfigChanges, getQueueCommercial, getQueueOverview, getQueueStatus,
  paginate, sortCases, type QueueFilter, type QueueSort,
} from '../queueUtils';

export type QueueColumn = 'case' | 'change' | 'verification' | 'commercial' | 'updated' | 'entry';

export interface QueueViewState {
  query: string;
  filters: QueueFilter[];
  sort: QueueSort;
  pageSize: 10 | 20;
  page: number;
  density: 'comfortable' | 'compact';
  columns: Record<QueueColumn, boolean>;
}

export const DEFAULT_QUEUE_STATE: QueueViewState = {
  query: '',
  filters: [],
  sort: 'updated-desc',
  pageSize: 10,
  page: 1,
  density: 'comfortable',
  columns: { case: true, change: true, verification: true, commercial: true, updated: true, entry: true },
};

const FILTERS: Array<{ id: QueueFilter; label: string }> = [
  { id: 'unanalysed', label: '未推演' },
  { id: 'review', label: '含人工核验' },
  { id: 'retest', label: '含补测' },
  { id: 'replied', label: '已有回复' },
];

const SORTS: Array<{ id: QueueSort; label: string }> = [
  { id: 'updated-desc', label: '更新最新' },
  { id: 'updated-asc', label: '更新最早' },
  { id: 'customer-asc', label: '客户 A–Z' },
  { id: 'fee-asc', label: '费用从低到高' },
  { id: 'fee-desc', label: '费用从高到低' },
];

const OPTIONAL_COLUMNS: Array<{ id: Exclude<QueueColumn, 'case' | 'entry'>; label: string }> = [
  { id: 'change', label: '参数变更' },
  { id: 'verification', label: '核验摘要' },
  { id: 'commercial', label: '费用 / 交期' },
  { id: 'updated', label: '更新时间' },
];

function formatStatusIcon(status: ReturnType<typeof getQueueStatus>['key']) {
  if (status === 'review') return <AlertTriangle size={14} aria-hidden="true" />;
  if (status === 'retest') return <RefreshCw size={14} aria-hidden="true" />;
  if (status === 'ready') return <CheckCircle2 size={14} aria-hidden="true" />;
  return <CircleDashed size={14} aria-hidden="true" />;
}

function QueueStatusBadge({ caseRecord }: { caseRecord: CaseRecord }) {
  const status = getQueueStatus(caseRecord);
  return <span className={`queue-status queue-status-${status.key}`}>
    {formatStatusIcon(status.key)}
    <span>{status.label}</span>
  </span>;
}

function ChangeSummary({ caseRecord }: { caseRecord: CaseRecord }) {
  const changes = getConfigChanges(caseRecord);
  if (changes.length === 0) return <span className="queue-muted">未识别参数变化</span>;
  return <span className="queue-change-list">{changes.slice(0, 3).map((change) => <span className="queue-change-item" key={change.key}>{formatConfigChange(change)}</span>)}{changes.length > 3 && <span className="queue-more-change">+{changes.length - 3} 项</span>}</span>;
}

function VerificationSummary({ caseRecord }: { caseRecord: CaseRecord }) {
  const status = getQueueStatus(caseRecord);
  if (!status.hasAnalysis) return <div className="queue-verification"><QueueStatusBadge caseRecord={caseRecord} /><span>完成推演后显示逐项结论</span></div>;
  return <div className="queue-verification"><QueueStatusBadge caseRecord={caseRecord} /><span>{status.description}{status.hasRetest && status.hasReview ? ' · 同时含补测' : ''}</span>{caseRecord.quote && <small>已生成回复 · 未发送</small>}</div>;
}

function CommercialSummary({ caseRecord }: { caseRecord: CaseRecord }) {
  const commercial = getQueueCommercial(caseRecord);
  return <div className={`queue-commercial ${commercial.isUnknown ? 'is-unknown' : ''}`}>
    <strong>{commercial.feeLabel}</strong>
    <span>{commercial.leadTimeLabel}</span>
    {commercial.knownFeeLabel && <small>{commercial.knownFeeLabel}</small>}
    {commercial.commitmentLabel && <small>交期口径：{commercial.commitmentLabel}</small>}
    <small>{commercial.note}</small>
  </div>;
}

function CaseIdentity({ caseRecord }: { caseRecord: CaseRecord }) {
  const model = caseRecord.requestedConfig.model || '型号未知';
  return <div className="queue-case-identity"><strong title={caseRecord.name}>{caseRecord.name || '未命名案件'}</strong><span title={caseRecord.buyer}>{caseRecord.buyer || '买家待确认'}</span><small>{model}</small></div>;
}

function QueueRow({ caseRecord, state, onOpen, switchingCaseId }: { caseRecord: CaseRecord; state: QueueViewState; onOpen: (id: string) => void; switchingCaseId: string | null }) {
  const dateLabel = formatQueueDate(caseRecord.updatedAt);
  const columns = state.columns;
  return <tr className={`queue-table-row ${state.density === 'compact' ? 'is-compact' : ''}`}>
    <td className="queue-case-column"><CaseIdentity caseRecord={caseRecord} /></td>
    {columns.change && <td className="queue-change-column"><ChangeSummary caseRecord={caseRecord} /></td>}
    {columns.verification && <td><VerificationSummary caseRecord={caseRecord} /></td>}
    {columns.commercial && <td><CommercialSummary caseRecord={caseRecord} /></td>}
    {columns.updated && <td className="queue-updated" title={new Date(caseRecord.updatedAt).toLocaleString('zh-CN')}>{dateLabel}</td>}
    <td className="queue-entry-column"><button type="button" className="button button-secondary button-small queue-entry-button" disabled={Boolean(switchingCaseId)} onClick={() => onOpen(caseRecord.id)}>进入案件 <ChevronRight size={14} /></button></td>
  </tr>;
}

function MobileCaseItem({ caseRecord, state, onOpen, switchingCaseId }: { caseRecord: CaseRecord; state: QueueViewState; onOpen: (id: string) => void; switchingCaseId: string | null }) {
  const commercial = getQueueCommercial(caseRecord);
  const status = getQueueStatus(caseRecord);
  return <article className={`queue-mobile-item ${state.density === 'compact' ? 'is-compact' : ''}`}>
    <div className="queue-mobile-head"><CaseIdentity caseRecord={caseRecord} /><QueueStatusBadge caseRecord={caseRecord} /></div>
    <div className="queue-mobile-change"><span className="queue-mobile-label">参数变更</span><ChangeSummary caseRecord={caseRecord} /></div>
    <div className="queue-mobile-meta"><span><ListFilter size={13} /> {status.description}</span><span><strong>{commercial.feeLabel}</strong> · {commercial.leadTimeLabel}</span><span>{formatQueueDate(caseRecord.updatedAt)}</span></div>
    <div className="queue-mobile-hint">{commercial.knownFeeLabel || commercial.note}{commercial.commitmentLabel ? ` · 交期口径：${commercial.commitmentLabel}` : ''}{caseRecord.quote ? ' · 已生成回复（未发送）' : ''}</div>
    <button type="button" className="button button-secondary button-small queue-entry-button" disabled={Boolean(switchingCaseId)} onClick={() => onOpen(caseRecord.id)}>进入案件 <ChevronRight size={14} /></button>
  </article>;
}

interface CaseQueueProps {
  cases: CaseRecord[];
  state: QueueViewState;
  onStateChange: (next: QueueViewState | ((current: QueueViewState) => QueueViewState)) => void;
  onOpenCase: (id: string) => void;
  onNewCase: () => void;
  onOpenEvidence: () => void;
  switchingCaseId?: string | null;
}

export default function CaseQueue({ cases, state, onStateChange, onOpenCase, onNewCase, onOpenEvidence, switchingCaseId = null }: CaseQueueProps) {
  const filteredCases = useMemo(() => {
    return sortCases(filterCases(cases, state.query, state.filters), state.sort);
  }, [cases, state.filters, state.query, state.sort]);
  const page = useMemo(() => paginate(filteredCases, state.page, state.pageSize), [filteredCases, state.page, state.pageSize]);

  useEffect(() => {
    if (page.page !== state.page) onStateChange((current) => ({ ...current, page: page.page }));
  }, [onStateChange, page.page, state.page]);

  const update = <K extends keyof QueueViewState>(key: K, value: QueueViewState[K]) => onStateChange((current) => ({ ...current, [key]: value, ...(key === 'filters' ? { page: 1 } : {}) }));
  const toggleFilter = (filter: QueueFilter) => onStateChange((current) => ({ ...current, page: 1, filters: current.filters.includes(filter) ? current.filters.filter((item) => item !== filter) : [...current.filters, filter] }));
  const clearFilters = () => onStateChange((current) => ({ ...current, query: '', filters: [], page: 1 }));
  const hasFilter = state.query.trim().length > 0 || state.filters.length > 0;
  const showEmptyQueue = cases.length === 0;
  const columns = state.columns;
  const visibleColumnCount = 2 + Number(columns.change) + Number(columns.verification) + Number(columns.commercial) + Number(columns.updated);
  const overview = useMemo(() => getQueueOverview(cases), [cases]);
  const attentionCount = overview.attention;
  const attentionCases = cases.filter((caseRecord) => {
    const status = getQueueStatus(caseRecord);
    return status.key !== 'ready';
  }).slice(0, 3);
  const nextLabel = overview.pendingAnalysis > 0 ? '先完成变更理解' : overview.needsReview > 0 ? '先补齐人工核验' : overview.withRetest > 0 ? '先确认补测代价' : '可以发送报价草稿';

  return <div className="queue-page">
    <section className="queue-heading"><div><h1>案件队列</h1><p>搜索客户变更，按真实推演状态进入单案工作区。筛选条件可以叠加。</p></div><div className="queue-heading-actions"><button type="button" className="button button-secondary button-small" onClick={onOpenEvidence}><FolderOpen size={15} /> 进入证据库</button><button type="button" className="button button-primary button-small" onClick={onNewCase}><Plus size={15} /> 新建询盘</button></div></section>
    <section className="queue-dashboard" aria-label="工作台概览">
      <div className="queue-dashboard-main">
        <div className="dashboard-kicker"><span className="dashboard-signal" /> 本地合规报价工作台 <span className="dashboard-date">实时状态</span></div>
        <div className="dashboard-hero-row"><div><span className="dashboard-label">待处理询盘</span><strong className="dashboard-hero-number">{attentionCount}</strong><p>{attentionCount > 0 ? `其中 ${overview.needsReview} 个需要人工核验，${overview.withRetest} 个包含补测。` : '当前没有阻塞中的询盘，可以继续处理新变更。'}</p></div><div className="dashboard-hero-note"><span>下一步</span><strong>{nextLabel}</strong><small>所有费用、排期和回复均来自当前案件记录。</small></div></div>
      </div>
      <div className="dashboard-stat-grid" aria-label="案件状态统计">
        <div className="dashboard-stat"><span>全部案件</span><strong>{overview.total}</strong><small>已进入工作台</small></div>
        <div className="dashboard-stat dashboard-stat-amber"><span>待人工核验</span><strong>{overview.needsReview}</strong><small>证据或承诺风险</small></div>
        <div className="dashboard-stat dashboard-stat-red"><span>含补测</span><strong>{overview.withRetest}</strong><small>需要确认代价</small></div>
        <div className="dashboard-stat dashboard-stat-green"><span>已生成回复</span><strong>{overview.replyDrafts}</strong><small>等待人工发送</small></div>
      </div>
      <aside className="dashboard-side-panel"><div className="dashboard-side-head"><span>推进面板</span><span className="dashboard-side-count">{overview.analysed}/{overview.total}</span></div><div className="dashboard-progress"><span style={{ width: `${overview.total ? Math.round((overview.analysed / overview.total) * 100) : 0}%` }} /></div><p>案件已有规则推演结果</p><div className="dashboard-steps"><div className={overview.pendingAnalysis === 0 ? 'is-done' : 'is-current'}><span>01</span><div><strong>理解变更</strong><small>{overview.pendingAnalysis ? `${overview.pendingAnalysis} 个待处理` : '已完成'}</small></div></div><div className={overview.needsReview === 0 ? 'is-done' : 'is-current'}><span>02</span><div><strong>核验证据</strong><small>{overview.needsReview ? `${overview.needsReview} 个需确认` : '已完成'}</small></div></div><div className={overview.replyDrafts > 0 ? 'is-done' : ''}><span>03</span><div><strong>回传报价</strong><small>{overview.replyDrafts ? `${overview.replyDrafts} 个草稿待发送` : '等待报价草稿'}</small></div></div></div>{attentionCases.length > 0 && <div className="dashboard-next-list"><span>优先处理</span>{attentionCases.map((caseRecord) => <button type="button" key={caseRecord.id} onClick={() => onOpenCase(caseRecord.id)}><span>{caseRecord.name}</span><small>{getQueueStatus(caseRecord).label}</small><ChevronRight size={14} /></button>)}</div>}</aside>
    </section>
    <section className="queue-toolbar" aria-label="案件筛选与排序">
      <label className="queue-search"><Search size={17} aria-hidden="true" /><span className="sr-only">搜索案件</span><input value={state.query} onChange={(event) => onStateChange((current) => ({ ...current, query: event.target.value, page: 1 }))} placeholder="搜索客户、案件、型号或买家原话" /></label>
      <div className="queue-toolbar-actions"><label className="queue-select"><span>排序</span><select value={state.sort} onChange={(event) => onStateChange((current) => ({ ...current, sort: event.target.value as QueueSort, page: 1 }))}>{SORTS.map((option) => <option value={option.id} key={option.id}>{option.label}</option>)}</select></label><label className="queue-select"><span>每页</span><select value={state.pageSize} onChange={(event) => onStateChange((current) => ({ ...current, pageSize: Number(event.target.value) as 10 | 20, page: 1 }))}><option value="10">10</option><option value="20">20</option></select></label></div>
    </section>
    <div className="queue-filter-row"><span className="queue-filter-label"><Filter size={14} /> 筛选</span><button type="button" className={`queue-filter-chip ${state.filters.length === 0 ? 'active' : ''}`} aria-pressed={state.filters.length === 0} onClick={() => update('filters', [])}>全部</button>{FILTERS.map((filter) => <button type="button" key={filter.id} className={`queue-filter-chip ${state.filters.includes(filter.id) ? 'active' : ''}`} aria-pressed={state.filters.includes(filter.id)} onClick={() => toggleFilter(filter.id)}>{filter.label}</button>)}{hasFilter && <button type="button" className="queue-clear-button" onClick={clearFilters}><RotateCcw size={13} /> 清除筛选</button>}</div>
    <div className="queue-view-controls"><span>显示 {filteredCases.length} / {cases.length} 条</span><div className="queue-control-group"><details className="queue-columns-control"><summary><Columns3 size={14} /> 列显示</summary><div className="queue-columns-menu">{OPTIONAL_COLUMNS.map((column) => <label key={column.id}><input type="checkbox" checked={columns[column.id]} onChange={(event) => onStateChange((current) => ({ ...current, columns: { ...current.columns, [column.id]: event.target.checked } }))} /><span>{column.label}</span></label>)}<small>案件 / 入口始终显示</small></div></details><div className="queue-density" role="group" aria-label="列表密度"><span>密度</span><button type="button" className={state.density === 'comfortable' ? 'active' : ''} aria-pressed={state.density === 'comfortable'} onClick={() => update('density', 'comfortable')}>舒适</button><button type="button" className={state.density === 'compact' ? 'active' : ''} aria-pressed={state.density === 'compact'} onClick={() => update('density', 'compact')}>紧凑</button></div></div></div>
    {showEmptyQueue ? <section className="queue-empty"><CircleDashed size={26} /><strong>还没有案件</strong><p>先建立一个询盘，保存买家原话后再进入推演。</p><button type="button" className="button button-primary button-small" onClick={onNewCase}>新建询盘</button></section> : filteredCases.length === 0 ? <section className="queue-empty"><Search size={26} /><strong>没有符合条件的案件</strong><p>当前搜索或筛选没有结果，清除条件后查看全部案件。</p><button type="button" className="button button-secondary button-small" onClick={clearFilters}>清除筛选</button></section> : <>
      <section className={`queue-table-wrap ${state.density === 'compact' ? 'is-compact' : ''}`} aria-label="案件列表"><table className="queue-table"><thead><tr><th scope="col">案件 / 客户</th>{columns.change && <th scope="col">参数变更</th>}{columns.verification && <th scope="col">核验摘要</th>}{columns.commercial && <th scope="col">费用 / 交期</th>}{columns.updated && <th scope="col">更新时间</th>}<th scope="col">入口</th></tr></thead><tbody>{page.items.map((caseRecord) => <QueueRow key={caseRecord.id} caseRecord={caseRecord} state={state} onOpen={onOpenCase} switchingCaseId={switchingCaseId} />)}</tbody></table><div className="queue-table-a11y">当前显示 {page.items.length} 条，列 {visibleColumnCount} 项。请通过“进入案件”打开详情。</div></section>
      <section className="queue-mobile-list" aria-label="案件摘要列表">{page.items.map((caseRecord) => <MobileCaseItem key={caseRecord.id} caseRecord={caseRecord} state={state} onOpen={onOpenCase} switchingCaseId={switchingCaseId} />)}</section>
      <div className="queue-pagination"><span>第 {page.page} / {page.pageCount} 页</span><div><button type="button" className="icon-button" aria-label="上一页" disabled={page.page <= 1} onClick={() => update('page', page.page - 1)}><ChevronLeft size={16} /></button><button type="button" className="icon-button" aria-label="下一页" disabled={page.page >= page.pageCount} onClick={() => update('page', page.page + 1)}><ChevronRight size={16} /></button></div></div>
    </>}
  </div>;
}

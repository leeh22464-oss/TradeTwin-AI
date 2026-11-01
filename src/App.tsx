import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRef } from 'react';
import { createPortal } from 'react-dom';
import {
  AlertTriangle, ArrowDownToLine, ArrowLeft, ArrowUpRight, BookOpen, Bot, Check, CheckCircle2, ChevronDown,
  ChevronLeft, ChevronRight, CircleHelp, ClipboardCheck, Clock3, FileCheck2, FileText,
  CircleDashed, FolderOpen, Gauge, Globe2, History, Inbox, Layers3, Lightbulb, Loader2, Menu,
  MessageSquare, Moon, MoreHorizontal, PackageCheck, PanelLeft, Plus, RefreshCw, Save,
  Search, Send, Settings2, ShieldAlert, Sparkles, Sun, Tag, Upload, UsersRound, X,
} from 'lucide-react';
import type {
  AnalysisResult, AuditEvent, BootstrapData, CaseRecord, Channel, EvidencePage,
  Coverage, EvidenceReport, Finding, FindingStatus, ProductConfig, QuoteResult,
} from '../shared/types';
import CaseQueue, { DEFAULT_QUEUE_STATE, type QueueViewState } from './components/CaseQueue';
import KnowledgeWorkspace from './components/KnowledgeWorkspace';
import NewInquiryDialog from './components/NewInquiryDialog';
import { getQueueStatus } from './queueUtils';
import { getViewTitle, primaryNavigation } from './navigation';
import { resolveTheme, type Theme } from './theme';

type View = 'queue' | 'workspace' | 'evidence' | 'knowledge' | 'audit' | 'settings';
type Notice = { kind: 'success' | 'error' | 'info'; message: string } | null;
type TestScopeMap = NonNullable<EvidenceReport['testScopes']>;

const TEST_SCOPE_OPTIONS: Array<{ id: string; label: string }> = [
  { id: 'temperature', label: '温升 / 耐热' },
  { id: 'ip', label: '防尘防水' },
  { id: 'emc', label: 'EMC' },
  { id: 'rohs', label: 'RoHS / REACH' },
  { id: 'electrical-strength', label: '电气强度 / 绝缘' },
];

const TEST_SCOPE_LABELS = Object.fromEntries(TEST_SCOPE_OPTIONS.map((item) => [item.id, item.label]));

const FAILED_REPORT_JSON_EXAMPLE = `{
  "title": "TR-NEW 结构化补录",
  "kind": "safety",
  "coverage": {
    "series": "NL-L",
    "powerMinW": 18,
    "powerMaxW": 40,
    "ipLevels": ["IP20", "IP44"],
    "drivers": ["DRV-A"],
    "materials": ["original-material"],
    "markets": ["DE", "EU"],
    "tests": ["temperature", "ip"],
    "confidence": 0.8
  },
  "pages": [{
    "page": 1,
    "text": "人工补录原文摘录：NL-L，18W–40W，DRV-A，温升与 IP20/IP44 项目。"
  }],
  "testScopes": {
    "temperature": {
      "coverage": {
        "series": "NL-L", "powerMinW": 18, "powerMaxW": 40,
        "ipLevels": ["IP20", "IP44"], "drivers": ["DRV-A"],
        "materials": ["original-material"], "markets": ["DE", "EU"],
        "tests": ["temperature"], "confidence": 0.8
      },
      "page": 1,
      "quote": "人工补录原文摘录：NL-L，18W–40W，DRV-A，温升与 IP20/IP44 项目。"
    }
  }
}`;

const emptyConfig: ProductConfig = { model: '', powerW: null, ip: '', driver: '', material: '', market: '' };

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { headers: { ...(init?.body instanceof FormData ? {} : { 'Content-Type': 'application/json' }), ...init?.headers }, ...init });
  const payload = await response.json().catch(() => null);
  if (!response.ok) throw new Error(payload?.error || payload?.message || `请求失败（${response.status}）`);
  return payload as T;
}

function formatEuro(value: number | null | undefined) {
  if (value === null || value === undefined) return '待核验';
  return new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 }).format(value);
}

function StatusPill({ status }: { status: FindingStatus | 'ready' | 'needs_review' | 'failed' | 'demo' | 'live' | 'fallback' }) {
  const labels: Record<string, string> = { retest: '需补测', reuse: '可沿用', update: '需更新', review: '待人工核验', warning: '承诺风险', ready: '已载入', needs_review: '需确认', failed: '解析失败', demo: '演示模式', live: '已接入', fallback: '回退模式' };
  return <span className={`status-pill status-${status}`}><span className="status-dot" />{labels[status] || status}</span>;
}

function useDialogAccessibility(dialogRef: React.RefObject<HTMLElement | null>, onClose: () => void) {
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const dialogRoot = document.getElementById('dialog-root');
    const portalContainer = dialog.closest<HTMLElement>('[data-dialog-portal]');
    const inerted: Array<{ element: HTMLElement; value: string | null }> = [];
    for (const child of Array.from(document.body.children)) {
      if (child !== dialogRoot && child !== portalContainer && child instanceof HTMLElement) {
        inerted.push({ element: child, value: child.getAttribute('inert') });
        child.setAttribute('inert', '');
      }
    }
    const bodyOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const focusSelector = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
    const focusFirst = () => {
      const initial = dialog.querySelector<HTMLElement>('[data-dialog-initial-focus]');
      const focusable = Array.from(dialog.querySelectorAll<HTMLElement>(focusSelector));
      (initial || focusable[0] || dialog).focus();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeRef.current();
        return;
      }
      if (event.key !== 'Tab') return;
      const focusable = Array.from(dialog.querySelectorAll<HTMLElement>(focusSelector));
      if (focusable.length === 0) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    dialog.addEventListener('keydown', onKeyDown);
    const focusFrame = requestAnimationFrame(focusFirst);
    return () => {
      cancelAnimationFrame(focusFrame);
      dialog.removeEventListener('keydown', onKeyDown);
      for (const item of inerted) {
        if (item.value === null) item.element.removeAttribute('inert');
        else item.element.setAttribute('inert', item.value);
      }
      document.body.style.overflow = bodyOverflow;
      if (previousFocus?.isConnected) requestAnimationFrame(() => previousFocus.focus());
    };
  }, [dialogRef]);
}

function IconButton({ label, children, onClick, disabled = false, buttonRef, initialFocus = false, pressed }: { label: string; children: React.ReactNode; onClick?: () => void; disabled?: boolean; buttonRef?: React.Ref<HTMLButtonElement>; initialFocus?: boolean; pressed?: boolean }) {
  return <button ref={buttonRef} className="icon-button" aria-label={label} aria-pressed={pressed} title={label} onClick={onClick} disabled={disabled} data-dialog-initial-focus={initialFocus ? true : undefined}>{children}</button>;
}

function Field({ label, value, onChange, type = 'text', placeholder, readOnly = false, autoFocus = false }: { label: string; value: string | number | null; onChange: (value: string) => void; type?: string; placeholder?: string; readOnly?: boolean; autoFocus?: boolean }) {
  return <label className={`field ${readOnly ? 'field-readonly' : ''}`}><span>{label}</span><input type={type} value={value ?? ''} placeholder={placeholder ?? '未填写'} onChange={(event) => onChange(event.target.value)} readOnly={readOnly} data-dialog-initial-focus={autoFocus ? true : undefined} /></label>;
}

function ConfigCard({ title, config, editable, onChange, accent }: { title: string; config: ProductConfig; editable?: boolean; onChange?: (key: keyof ProductConfig, value: string) => void; accent?: boolean }) {
  return <section className={`config-card ${accent ? 'config-card-accent' : ''}`}>
    <div className="config-card-head"><div><span className="overline">{editable ? '客户要求' : '当前证据基线'}</span><h3>{title}</h3></div>{editable && <span className="edit-mark"><Settings2 size={14} /> 可编辑</span>}</div>
    <div className="config-grid">
      <Field label="型号 / 系列" value={config.model} onChange={(v) => onChange?.('model', v)} readOnly={!editable} />
      <Field label="额定功率（W）" value={config.powerW} type="number" onChange={(v) => onChange?.('powerW', v)} placeholder="例如 36" readOnly={!editable} />
      <Field label="防护等级" value={config.ip} onChange={(v) => onChange?.('ip', v)} placeholder="例如 IP44" readOnly={!editable} />
      <Field label="驱动电源" value={config.driver} onChange={(v) => onChange?.('driver', v)} placeholder="例如 DRV-A" readOnly={!editable} />
      <Field label="材料组合" value={config.material} onChange={(v) => onChange?.('material', v)} readOnly={!editable} />
      <Field label="目标市场" value={config.market} onChange={(v) => onChange?.('market', v)} readOnly={!editable} />
    </div>
  </section>;
}

function FindingRow({ finding, reports, onEvidence }: { finding: Finding; reports: EvidenceReport[]; onEvidence: (finding: Finding) => void }) {
  return <button className="finding-row" onClick={() => onEvidence(finding)}>
    <div className="finding-status"><StatusPill status={finding.status} /></div>
    <div className="finding-main"><strong>{finding.title}</strong><p>{finding.reason}</p><div className="finding-meta">{finding.ruleIds.join(' · ') || '规则待核验'}{finding.evidence.length > 0 && <><span>·</span><FileCheck2 size={13} /> {finding.evidence.length} 条证据</>}</div></div>
    <div className="finding-cost">{finding.feeEur !== null ? <><strong>{formatEuro(finding.feeEur)}</strong><span>+{finding.days} 工作日</span></> : <span className="muted">—</span>}<ChevronRight size={16} /></div>
  </button>;
}

function EvidenceDrawer({ finding, reports, onClose, onOverride }: { finding: Finding | null; reports: EvidenceReport[]; onClose: () => void; onOverride: (findingId: string, decision: 'accept' | 'reject', reason: string) => Promise<void> }) {
  const dialogRef = useRef<HTMLElement | null>(null);
  useDialogAccessibility(dialogRef, onClose);
  if (!finding) return null;
  const OverrideForm = () => {
    const [decision, setDecision] = useState<'accept' | 'reject'>('accept');
    const [reason, setReason] = useState('');
    const [saving, setSaving] = useState(false);
    const submit = async () => { if (!reason.trim()) return; setSaving(true); try { await onOverride(finding.id, decision, reason.trim()); setReason(''); } finally { setSaving(false); } };
    return <div className="override-box"><div className="override-box-head"><h4>人工覆盖</h4><span>原结论不会被删除</span></div><div className="override-controls"><select value={decision} onChange={(event) => setDecision(event.target.value as 'accept' | 'reject')}><option value="accept">接受当前建议</option><option value="reject">驳回当前建议</option></select><textarea value={reason} onChange={(event) => setReason(event.target.value)} placeholder="必填：说明工程师或业务确认依据…" rows={3} /></div><button className="button button-primary button-small full-button" disabled={saving || !reason.trim()} onClick={submit}>{saving ? <Loader2 size={14} className="spin" /> : <ClipboardCheck size={14} />} 保存覆盖理由</button></div>;
  };
  const portalTarget = document.getElementById('dialog-root') || document.body;
  return createPortal(<div className="drawer-backdrop" data-dialog-portal onClick={onClose}><aside ref={dialogRef} className="evidence-drawer" role="dialog" aria-modal="true" aria-labelledby="evidence-dialog-title" tabIndex={-1} onClick={(e) => e.stopPropagation()}>
    <div className="drawer-head"><div><div className="drawer-meta">证据链 · {finding.ruleIds.join(' / ') || '未命中规则'}</div><h2 id="evidence-dialog-title">{finding.title}</h2></div><IconButton label="关闭证据详情" onClick={onClose} initialFocus><X size={18} /></IconButton></div>
    <div className="drawer-status"><StatusPill status={finding.status} /><span>{finding.reason}</span></div>
    <div className="drawer-section"><h4>命中规则</h4><div className="rule-chip-list">{finding.ruleIds.length ? finding.ruleIds.map((rule) => <span className="rule-chip" key={rule}>{rule}</span>) : <span className="muted">暂无确认规则</span>}</div></div>
    <div className="drawer-section"><h4>来源证据</h4>{finding.evidence.length === 0 ? <div className="empty-mini"><ShieldAlert size={17} /> 没有可回溯证据，必须人工确认。</div> : finding.evidence.map((ref) => { const report = reports.find((item) => item.id === ref.reportId); const page: EvidencePage | undefined = report?.pages.find((item) => item.page === ref.page); const source = ref.source || report?.knowledgeSource; return <article className="evidence-quote" key={`${ref.reportId}-${ref.page}`}><div className="evidence-quote-head"><span>{report?.id || ref.reportId} · 第 {ref.page} 页</span><a href={`/api/reports/${ref.reportId}/file`} target="_blank" rel="noreferrer">打开原文 <ArrowUpRight size={13} /></a></div><p>{ref.quote || page?.text || '未提取到文字，请查看原文。'}</p>{source && <div className="evidence-provenance"><strong>推演来源</strong><span>{source.path}</span>{source.documentId && <span>文档 {source.documentId}</span>}{source.ruleId && <span>规则 {source.ruleId}</span>}{source.page !== undefined && <span>第 {source.page} 页</span>}{source.sha256 && <span>指纹 {source.sha256.slice(0, 12)}…</span>}</div>}{report?.source === 'synthetic' && <span className="synthetic-label">合成示意数据</span>}</article>; })}</div>
    <OverrideForm /><div className="drawer-note"><AlertTriangle size={16} /><span>系统只整理证据和规则命中，不替代检测机构或认证工程师的最终判断。</span></div>
  </aside></div>, portalTarget);
}

function ModelBadge({ model }: { model: BootstrapData['model'] | undefined }) {
  if (!model) return <span className="model-badge"><span className="pulse-dot" /> 状态读取中</span>;
  return <span className={`model-badge model-${model.mode}`}><span className="pulse-dot" /><span className="model-name">{model.mode === 'live' ? model.model || '模型已接入' : '本地演示'}</span><span className="model-separator" /><span className="model-config">{model.configured ? '结构化调用' : '无密钥也可运行'}</span></span>;
}

export default function App() {
  const [view, setView] = useState<View>('queue');
  const [data, setData] = useState<BootstrapData | null>(null);
  const [activeCase, setActiveCase] = useState<CaseRecord | null>(null);
  const [notice, setNotice] = useState<Notice>(null);
  const [loading, setLoading] = useState(true);
  const [bootstrapError, setBootstrapError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [switchingCaseId, setSwitchingCaseId] = useState<string | null>(null);
  const [dirtyDraftCaseId, setDirtyDraftCaseId] = useState<string | null>(null);
  const [queueState, setQueueState] = useState<QueueViewState>(DEFAULT_QUEUE_STATE);
  const [mobileNav, setMobileNav] = useState(false);
  const [drawerFinding, setDrawerFinding] = useState<Finding | null>(null);
  const [showNewCase, setShowNewCase] = useState(false);
  const [pendingNavigation, setPendingNavigation] = useState<(() => void) | null>(null);
  const [theme, setTheme] = useState<Theme>(() => {
    if (typeof window === 'undefined') return 'light';
    let stored: string | null = null;
    try { stored = window.localStorage.getItem('tradetwin-theme'); } catch { /* private browsing can deny storage */ }
    return resolveTheme(stored);
  });
  const activeCaseRef = useRef<CaseRecord | null>(null);
  const caseRequestRef = useRef(0);

  useEffect(() => { activeCaseRef.current = activeCase; }, [activeCase]);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme;
    document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')?.setAttribute('content', theme === 'dark' ? '#111715' : '#f3f5f2');
    try { window.localStorage.setItem('tradetwin-theme', theme); } catch { /* private browsing can deny storage */ }
  }, [theme]);
  useEffect(() => { window.scrollTo({ top: 0, behavior: 'instant' }); }, [view, activeCase?.id]);
  useEffect(() => {
    if (!mobileNav) return;
    const toggle = document.querySelector<HTMLButtonElement>('.mobile-nav-toggle');
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); setMobileNav(false); }
      if (event.key === 'Tab') {
        const controls = [toggle, ...document.querySelectorAll<HTMLButtonElement>('.sidebar button:not(:disabled)')].filter((item): item is HTMLButtonElement => Boolean(item));
        const first = controls[0];
        const last = controls[controls.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    };
    const onResize = () => { if (window.innerWidth > 860) setMobileNav(false); };
    window.addEventListener('keydown', onKey);
    window.addEventListener('resize', onResize);
    return () => { window.removeEventListener('keydown', onKey); window.removeEventListener('resize', onResize); document.body.style.overflow = previousOverflow; toggle?.focus(); };
  }, [mobileNav]);

  const loadBootstrap = useCallback(async () => {
    setLoading(true);
    try {
      const next = await api<BootstrapData>('/api/bootstrap');
      setBootstrapError(null);
      setData(next);
      const current = activeCaseRef.current;
      if (!current && next.cases[0]) setActiveCase(next.cases[0]);
      else if (current) { const refreshed = next.cases.find((item) => item.id === current.id); if (refreshed) setActiveCase(refreshed); }
    } catch (error) {
      const message = error instanceof Error ? error.message : '无法连接到服务';
      setBootstrapError(message);
      setNotice({ kind: 'error', message: `数据载入失败：${message}` });
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { void loadBootstrap(); }, [loadBootstrap]);
  useEffect(() => { if (!notice) return; const timer = window.setTimeout(() => setNotice(null), 6000); return () => window.clearTimeout(timer); }, [notice]);
  useEffect(() => {
    if (!dirtyDraftCaseId) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirtyDraftCaseId]);

  const cases = data?.cases ?? [];
  const applyCaseUpdate = useCallback((updated: CaseRecord) => {
    setData((prev) => prev ? { ...prev, cases: prev.cases.map((item) => item.id === updated.id ? updated : item) } : prev);
    setActiveCase((current) => current?.id === updated.id ? updated : current);
  }, []);
  const selectCase = async (id: string) => {
    const requestId = ++caseRequestRef.current;
    const cached = cases.find((item) => item.id === id);
    if (cached) setActiveCase(cached);
    setSwitchingCaseId(id);
    try {
      const fresh = await api<CaseRecord>(`/api/cases/${id}`);
      if (requestId !== caseRequestRef.current) return;
      setActiveCase(fresh);
      setData((prev) => prev ? { ...prev, cases: prev.cases.map((item) => item.id === fresh.id ? fresh : item) } : prev);
    } catch (error) {
      if (requestId === caseRequestRef.current) setNotice({ kind: 'error', message: error instanceof Error ? `案件读取失败：${error.message}` : '案件读取失败' });
    } finally {
      if (requestId === caseRequestRef.current) setSwitchingCaseId(null);
    }
  };

  const navigate = (next: View) => {
    if (busy || switchingCaseId) { setNotice({ kind: 'info', message: '正在保存或读取案件，请完成后再切换页面。' }); return; }
    const proceed = () => { setView(next); setMobileNav(false); };
    if (next !== 'workspace' && dirtyDraftCaseId) { setMobileNav(false); setPendingNavigation(() => proceed); return; }
    proceed();
  };

  const openCase = (id: string) => {
    if (busy || loading || switchingCaseId) { setNotice({ kind: 'info', message: '正在处理案件，请稍后再切换。' }); return; }
    const proceed = () => { setView('workspace'); setMobileNav(false); void selectCase(id); };
    if (dirtyDraftCaseId && activeCase?.id !== id) { setMobileNav(false); setPendingNavigation(() => proceed); return; }
    proceed();
  };

  const markDraftDirty = useCallback((caseId: string | null) => setDirtyDraftCaseId(caseId), []);
  const requestNewCase = () => {
    if (busy || loading || switchingCaseId) { setNotice({ kind: 'info', message: '正在处理案件，请完成后再新建询盘。' }); return; }
    if (dirtyDraftCaseId) {
      setNotice({ kind: 'info', message: '当前案件有未保存配置，请先保存后再新建询盘。' });
      return;
    }
    setMobileNav(false);
    setShowNewCase(true);
  };
  const refreshData = () => {
    if (busy || switchingCaseId) { setNotice({ kind: 'info', message: '正在处理案件，请完成后再刷新数据。' }); return; }
    if (dirtyDraftCaseId) {
      setNotice({ kind: 'info', message: '当前案件有未保存配置，请先保存后再刷新数据。' });
      return;
    }
    void loadBootstrap();
  };

  const mutateCase = async (method: 'PATCH', body: unknown): Promise<boolean> => {
    if (!activeCase) return false;
    setBusy('save');
    try { const updated = await api<CaseRecord>(`/api/cases/${activeCase.id}`, { method, body: JSON.stringify(body) }); applyCaseUpdate(updated); setNotice({ kind: 'success', message: '已保存，下一次推演会使用最新配置' }); return true; } catch (error) { setNotice({ kind: 'error', message: error instanceof Error ? error.message : '保存失败' }); return false; } finally { setBusy(null); }
  };

  const runAnalyze = async (config?: ProductConfig) => {
    if (!activeCase) return;
    setBusy('analyze');
    try { const updated = await api<CaseRecord>(`/api/cases/${activeCase.id}/analyze`, { method: 'POST', body: JSON.stringify({ config, idempotencyKey: `${activeCase.id}-${JSON.stringify(config || activeCase.requestedConfig)}` }) }); applyCaseUpdate(updated); setNotice({ kind: 'success', message: '推演完成：证据与报价账单已更新' }); } catch (error) { setNotice({ kind: 'error', message: error instanceof Error ? error.message : '推演失败' }); } finally { setBusy(null); }
  };

  const sendChat = async (message: string, channel?: Channel) => {
    if (!activeCase || !message.trim()) return;
    setBusy('chat');
    try { const updated = await api<CaseRecord>(`/api/cases/${activeCase.id}/chat`, { method: 'POST', body: JSON.stringify({ message, channel: channel ?? activeCase.channel }) }); applyCaseUpdate(updated); } catch (error) { setNotice({ kind: 'error', message: error instanceof Error ? error.message : '消息发送失败' }); } finally { setBusy(null); }
  };

  const createCase = async (payload: { name: string; buyer: string; inquiry: string; channel: Channel }) => {
    setBusy('create');
    try { const created = await api<CaseRecord>('/api/cases', { method: 'POST', body: JSON.stringify(payload) }); setData((prev) => prev ? { ...prev, cases: [created, ...prev.cases] } : prev); setActiveCase(created); setDirtyDraftCaseId(null); setView('workspace'); setShowNewCase(false); setNotice({ kind: 'success', message: '新询盘已建立，已进入案件详情' }); } catch (error) { setNotice({ kind: 'error', message: error instanceof Error ? error.message : '新建失败' }); } finally { setBusy(null); }
  };
  const openImportedCase = (caseRecord: CaseRecord) => {
    setData((prev) => prev ? { ...prev, cases: [caseRecord, ...prev.cases.filter((item) => item.id !== caseRecord.id)] } : prev);
    setActiveCase(caseRecord);
    setDirtyDraftCaseId(null);
    setView('workspace');
    setShowNewCase(false);
    setNotice({ kind: 'success', message: '询盘来源已导入并关联到案件' });
  };

  return <div className="app-shell">
    <button className={`mobile-nav-toggle ${mobileNav ? 'is-open' : ''}`} onClick={() => setMobileNav((value) => !value)} aria-label={mobileNav ? '关闭导航' : '打开导航'} aria-expanded={mobileNav} aria-controls="app-sidebar">{mobileNav ? <X size={20} /> : <Menu size={20} />}</button>
    {mobileNav && <button className="mobile-nav-scrim" tabIndex={-1} aria-hidden="true" onClick={() => setMobileNav(false)} />}
    <Sidebar activeView={view} setView={(next) => navigate(next === 'workspace' ? 'queue' : next)} cases={cases} activeCase={activeCase} onOpenCase={openCase} onNew={requestNewCase} mobileOpen={mobileNav} switchingCaseId={switchingCaseId} />
    <main className="main-shell" inert={mobileNav}>
      <Topbar view={view} caseRecord={activeCase} model={data?.model} loading={loading} onRefresh={refreshData} onNew={requestNewCase} theme={theme} onToggleTheme={() => setTheme((current) => current === 'dark' ? 'light' : 'dark')} />
      {notice && <div className={`notice notice-${notice.kind}`} role="status"><span>{notice.kind === 'error' ? <AlertTriangle size={16} /> : notice.kind === 'success' ? <Check size={16} /> : <CircleHelp size={16} />}</span>{notice.message}<button onClick={() => setNotice(null)} aria-label="关闭提示"><X size={15} /></button></div>}
      {loading ? <LoadingState /> : bootstrapError && !data ? <LoadErrorState message={bootstrapError} onRetry={loadBootstrap} /> : view === 'queue' ? <CaseQueue cases={cases} state={queueState} onStateChange={setQueueState} onOpenCase={openCase} onNewCase={requestNewCase} onOpenEvidence={() => navigate('evidence')} switchingCaseId={switchingCaseId} /> : view === 'workspace' && activeCase ? <Workspace key={activeCase.id} caseRecord={activeCase} reports={data?.reports ?? []} costs={data?.costs ?? []} busy={busy} caseLoading={Boolean(switchingCaseId)} onSave={(patch) => mutateCase('PATCH', patch)} onAnalyze={() => runAnalyze()} onChat={sendChat} onQuote={async (channel) => { if (!activeCase) return; setBusy('quote'); try { const updated = await api<CaseRecord>(`/api/cases/${activeCase.id}/quote`, { method: 'POST', body: JSON.stringify({ channel: channel ?? activeCase.channel }) }); applyCaseUpdate(updated); setNotice({ kind: 'success', message: '双语报价已生成，案件队列已更新' }); } catch (error) { setNotice({ kind: 'error', message: error instanceof Error ? error.message : '报价生成失败' }); } finally { setBusy(null); } }} onEvidence={setDrawerFinding} onOverride={async (findingId, decision, reason) => { if (!activeCase) return; try { await api<AuditEvent>(`/api/cases/${activeCase.id}/override`, { method: 'POST', body: JSON.stringify({ findingId, decision, reason, actor: '业务工作区' }) }); setNotice({ kind: 'success', message: '人工覆盖已记录，原结论保留在审计中' }); } catch (error) { setNotice({ kind: 'error', message: error instanceof Error ? error.message : '人工覆盖保存失败' }); } }} onBack={() => navigate('queue')} onDirtyChange={markDraftDirty} /> : view === 'evidence' ? <EvidenceView reports={data?.reports ?? []} onRefresh={loadBootstrap} onNotice={setNotice} /> : view === 'knowledge' ? <KnowledgeWorkspace entries={data?.knowledge ?? []} runtimeKnowledge={data?.runtimeKnowledge} onRefresh={loadBootstrap} onNotice={setNotice} /> : view === 'audit' ? <AuditView cases={cases} onNotice={setNotice} /> : <SettingsView model={data?.model} rules={data?.rules ?? []} costs={data?.costs ?? []} onNotice={setNotice} />}
    </main>
    {drawerFinding && <EvidenceDrawer finding={drawerFinding} reports={data?.reports ?? []} onClose={() => setDrawerFinding(null)} onOverride={async (findingId, decision, reason) => { if (!activeCase) return; try { await api<AuditEvent>(`/api/cases/${activeCase.id}/override`, { method: 'POST', body: JSON.stringify({ findingId, decision, reason, actor: '业务工作区' }) }); setNotice({ kind: 'success', message: '人工覆盖已记录，原结论保留在审计中' }); } catch (error) { setNotice({ kind: 'error', message: error instanceof Error ? error.message : '人工覆盖保存失败' }); } }} />}
    {showNewCase && <NewInquiryDialog onClose={() => setShowNewCase(false)} onCreate={createCase} onOpenCase={openImportedCase} busy={busy === 'create'} />}
    {pendingNavigation && <UnsavedChangesDialog onCancel={() => setPendingNavigation(null)} onDiscard={() => { const proceed = pendingNavigation; setPendingNavigation(null); setDirtyDraftCaseId(null); proceed(); }} />}
  </div>;
}

function Sidebar({ activeView, setView, cases, activeCase, onOpenCase, onNew, mobileOpen, switchingCaseId }: { activeView: View; setView: (view: View) => void; cases: CaseRecord[]; activeCase: CaseRecord | null; onOpenCase: (id: string) => void; onNew: () => void; mobileOpen: boolean; switchingCaseId: string | null }) {
  const iconByNavId: Record<string, React.ReactNode> = { workspace: <Gauge size={17} />, evidence: <FolderOpen size={17} />, knowledge: <BookOpen size={17} /> };
  const primaryNav: { id: View; label: string; icon: React.ReactNode }[] = primaryNavigation.map((item) => ({ ...item, icon: iconByNavId[item.id] }));
  const secondaryNav: { id: View; label: string; icon: React.ReactNode }[] = [
    { id: 'audit', label: '审计记录', icon: <History size={17} /> },
    { id: 'settings', label: '接入设置', icon: <Settings2 size={17} /> },
  ];
  const recentCases = [...cases].sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt)).slice(0, 4);
  const renderNav = (items: typeof primaryNav) => items.map((item) => {
    const active = item.id === 'workspace' ? activeView === 'queue' || activeView === 'workspace' : activeView === item.id;
    return <button key={item.id} type="button" className={active ? 'nav-item active' : 'nav-item'} onClick={() => setView(item.id === 'workspace' ? 'queue' : item.id)}>{item.icon}<span>{item.label}</span>{item.id === 'workspace' && cases.length > 0 && <em>{cases.length}</em>}</button>;
  });
  return <aside id="app-sidebar" className={`sidebar ${mobileOpen ? 'mobile-open' : ''}`}>
    <div className="brand"><div className="brand-mark">TT</div><div><strong>贸链通</strong><span>TRADETWIN AI</span></div></div>
    <div className="sidebar-kicker">合规报价工作台</div>
    <nav className="main-nav" aria-label="主导航">{renderNav(primaryNav)}</nav>
    <div className="sidebar-secondary"><div className="sidebar-group-label">记录与接入</div><nav className="main-nav" aria-label="记录与接入">{renderNav(secondaryNav)}</nav></div>
    <div className="sidebar-section"><div className="sidebar-section-title"><span>近期询盘</span><IconButton label="新建询盘" onClick={onNew}><Plus size={16} /></IconButton></div>{recentCases.map((item) => { const status = getQueueStatus(item); return <button type="button" key={item.id} disabled={Boolean(switchingCaseId)} className={`case-list-item ${activeCase?.id === item.id ? 'selected' : ''}`} onClick={() => onOpenCase(item.id)}><span className={`case-list-status case-status-${status.key}`} aria-hidden="true">{status.key === 'review' ? <AlertTriangle size={12} /> : status.key === 'retest' ? <RefreshCw size={12} /> : status.key === 'ready' ? <CheckCircle2 size={12} /> : <CircleDashed size={12} />}</span><span className="case-list-copy"><strong>{item.name}</strong><small>{item.buyer} · {status.label}</small></span>{item.round > 1 && <span className="case-round">R{item.round}</span>}</button>; })}</div>
    <div className="sidebar-bottom"><div className="data-note"><span className="data-note-icon"><ShieldAlert size={16} /></span><div><strong>演示数据环境</strong><span>所有报告与费率均为合成示例</span></div></div><div className="sidebar-user"><div className="avatar">CH</div><span><strong>业务工作区</strong><small>本地空间</small></span><MoreHorizontal size={16} /></div></div>
  </aside>;
}

function Topbar({ view, caseRecord, model, loading, onRefresh, onNew, theme, onToggleTheme }: { view: View; caseRecord: CaseRecord | null; model?: BootstrapData['model']; loading: boolean; onRefresh: () => void; onNew: () => void; theme: Theme; onToggleTheme: () => void }) {
  const titles: Record<View, string> = { queue: getViewTitle('queue'), workspace: caseRecord?.name || getViewTitle('workspace'), evidence: getViewTitle('evidence'), knowledge: getViewTitle('knowledge'), audit: getViewTitle('audit'), settings: getViewTitle('settings') };
  return <header className="topbar"><div className="topbar-left"><div className="breadcrumb"><span>TradeTwin AI</span><ChevronRight size={14} /><strong>{titles[view]}</strong></div>{view === 'workspace' && caseRecord && <span className="round-badge">第 {caseRecord.round} 轮推演</span>}</div><div className="topbar-actions"><ModelBadge model={model} /><IconButton label={theme === 'dark' ? '切换到浅色模式' : '切换到深色模式'} onClick={onToggleTheme} pressed={theme === 'dark'}><span className="theme-toggle-icon" aria-hidden="true">{theme === 'dark' ? <Sun size={17} /> : <Moon size={17} />}</span></IconButton><IconButton label="刷新数据" onClick={onRefresh} disabled={loading}><RefreshCw size={17} className={loading ? 'spin' : ''} /></IconButton>{view === 'workspace' && <button className="button button-primary button-small" onClick={onNew}><Plus size={16} /> 新建询盘</button>}</div></header>;
}

function LoadingState() { return <div className="loading-state"><Loader2 size={26} className="spin" /><strong>正在载入工作区</strong><span>连接本地证据与演示数据…</span></div>; }
function LoadErrorState({ message, onRetry }: { message: string; onRetry: () => void }) { return <div className="loading-state load-error-state"><AlertTriangle size={26} /><strong>案件数据暂时无法载入</strong><span>{message}</span><button type="button" className="button button-secondary button-small" onClick={onRetry}><RefreshCw size={14} /> 重试</button></div>; }

function Workspace({ caseRecord, reports, costs, busy, caseLoading = false, onSave, onAnalyze, onChat, onQuote, onEvidence, onOverride, onBack, onDirtyChange }: { caseRecord: CaseRecord; reports: EvidenceReport[]; costs: BootstrapData['costs']; busy: string | null; caseLoading?: boolean; onSave: (patch: unknown) => Promise<boolean | void>; onAnalyze: () => void; onChat: (message: string, channel?: Channel) => void; onQuote: (channel?: Channel) => void; onEvidence: (finding: Finding) => void; onOverride: (findingId: string, decision: 'accept' | 'reject', reason: string) => Promise<void>; onBack: () => void; onDirtyChange: (caseId: string | null) => void }) {
  const analysis = caseRecord.analysis;
  const [tab, setTab] = useState<'bill' | 'reply'>('bill');
  const [message, setMessage] = useState('');
  const [channel, setChannel] = useState<Channel>(caseRecord.channel || 'email');
  const [expanded, setExpanded] = useState<string | null>(null);
  const [draft, setDraft] = useState<ProductConfig>(caseRecord.requestedConfig || emptyConfig);
  const [quantity, setQuantity] = useState(caseRecord.quantity || 1);
  const [unitPriceEur, setUnitPriceEur] = useState(caseRecord.unitPriceEur || 0);
  const [dirty, setDirty] = useState(false);
  useEffect(() => { onDirtyChange(dirty ? caseRecord.id : null); }, [caseRecord.id, dirty, onDirtyChange]);
  useEffect(() => {
    if (dirty) return;
    setDraft(caseRecord.requestedConfig || emptyConfig);
    setQuantity(caseRecord.quantity || 1);
    setUnitPriceEur(caseRecord.unitPriceEur || 0);
    setChannel(caseRecord.channel || 'email');
  }, [caseRecord, dirty]);
  const requested = draft;
  const base = caseRecord.baseConfig || emptyConfig;
  const retest = analysis?.findings.filter((item) => item.status === 'retest') ?? [];
  const review = analysis?.findings.filter((item) => item.status === 'review' || item.status === 'warning') ?? [];
  const reused = analysis?.findings.filter((item) => item.status === 'reuse') ?? [];
  const update = analysis?.findings.filter((item) => item.status === 'update') ?? [];
  const knownCostEur = analysis?.findings.reduce((sum, finding) => sum + ((finding.status === 'retest' || finding.status === 'review') && finding.feeEur !== null ? finding.feeEur : 0), 0) ?? null;
  const costNeedsReview = Boolean(analysis && (analysis.reviewCount > 0 || review.length > 0 || analysis.leadTimeDays === null || !analysis.canQuote));
  const totalCostLabel = analysis ? (costNeedsReview ? '待核验' : formatEuro(analysis.totalCostEur)) : '等待推演';
  const alternativeCostLabel = (alternative: AnalysisResult['alternatives'][number]) => alternative.leadTimeDays === null ? (alternative.totalCostEur > 0 ? `待核验 · 已知 ${formatEuro(alternative.totalCostEur)}` : '待核验') : formatEuro(alternative.totalCostEur);
  const primaryAlternative = analysis?.alternatives.find((item) => item.id === 'A');
  const updateDraft = (key: keyof ProductConfig, value: string) => { setDraft((current) => ({ ...current, [key]: key === 'powerW' ? (value === '' ? null : Number(value)) : value })); setDirty(true); };
  const saveDraft = async () => { const saved = await onSave({ config: draft, quantity, unitPriceEur }); if (saved === false) return false; setDirty(false); return true; };
  const continueChat = async (content: string) => { if (dirty) { const saved = await saveDraft(); if (saved === false) return; } onChat(content, channel); };
  const send = async () => { const content = message.trim(); if (!content) return; if (dirty) { const saved = await saveDraft(); if (saved === false) return; } setMessage(''); onChat(content, channel); };
  const chooseAlternative = (alternative: AnalysisResult['alternatives'][number]) => { const configLabel = `${alternative.config.powerW ?? '?'}W / ${alternative.config.ip ?? 'IP?'}`; void continueChat(`客户选择方案 ${alternative.id}（${configLabel}）。请重新计算补测、报价和交期；不要承诺具体交期。`); };

  const generateQuote = async () => { if (dirty) { const saved = await saveDraft(); if (saved === false) return; } onQuote(channel); };
  return <div className="workspace-page">
    {caseLoading && <div className="case-loading-strip" role="status"><Loader2 size={14} className="spin" /> 正在读取案件最新数据，暂时锁定编辑控件…</div>}
    {caseRecord.extractionReview && <div className="quote-warning case-review-banner" role="status"><AlertTriangle size={15} /><span>询盘参数待确认：{caseRecord.extractionReview} 请核对并保存完整配置后再生成报价。</span></div>}
    <section className="workspace-intro"><div><div className="title-meta">外贸变更推演 · {caseRecord.buyer} <span className="round-badge">第 {caseRecord.round} 轮</span></div><h1>{caseRecord.name}</h1><p>{caseRecord.inquiry || '正在核对客户配置变更。'}</p></div><div className="intro-actions"><button className="button button-secondary button-small" onClick={onBack} disabled={caseLoading}><ArrowLeft size={15} /> 返回案件队列</button><span className={`save-state ${dirty ? 'is-dirty' : ''}`}>{dirty ? '未保存' : analysis ? '已保存 · 可推演' : '已保存 · 尚未推演'}</span><button className="button button-secondary button-small" onClick={() => void saveDraft()} disabled={!dirty || caseLoading || busy === 'save'}>{busy === 'save' ? <Loader2 size={15} className="spin" /> : <Save size={15} />} 保存配置</button><a className={`button button-secondary button-small ${caseLoading ? 'is-disabled-link' : ''}`} href={caseLoading ? undefined : `/api/cases/${caseRecord.id}/export`} target="_blank" rel="noreferrer" aria-disabled={caseLoading}><ArrowDownToLine size={16} /> 导出案件</a><button className="button button-primary button-small" onClick={async () => { if (dirty) { const saved = await saveDraft(); if (!saved) return; } onAnalyze(); }} disabled={caseLoading || busy === 'analyze' || busy === 'save'}>{busy === 'analyze' ? <Loader2 size={16} className="spin" /> : <RefreshCw size={16} />} {busy === 'analyze' ? '推演中…' : '重新推演'}</button></div></section>
    <nav className="case-detail-nav" aria-label="案件详情分段"><a href="#case-config">配置</a><a href="#case-evidence">证据</a><a href="#case-bill">账单</a><a href="#case-quote">报价方案</a></nav>
    <div className="workflow-strip"><div className="workflow-step complete"><span>01</span><div><strong>理解变更</strong><small>配置与客户原话</small></div><Check size={15} /></div><div className="workflow-line complete" /><div className={`workflow-step ${analysis ? 'complete' : 'current'}`}><span>02</span><div><strong>核验证据</strong><small>覆盖范围与补测</small></div>{analysis ? <Check size={15} /> : <span className="workflow-active" />}</div><div className="workflow-line" /><div className={`workflow-step ${caseRecord.quote ? 'complete' : ''}`}><span>03</span><div><strong>生成报价</strong><small>英德回复与待办</small></div>{caseRecord.quote ? <Check size={15} /> : <span className="workflow-active" />}</div></div>
    <section className="case-bill-snapshot" aria-label="账单摘要"><div><span>账单摘要</span><strong>{analysis ? (costNeedsReview ? '待核验' : formatEuro(analysis.totalCostEur)) : '待推演'}</strong></div><div><span>排期</span><strong>{!analysis ? '待确认' : analysis.leadTimeDays === null ? (analysis.calculation.estimatedDays !== undefined ? `约 ${analysis.calculation.estimatedDays} 工作日（待人工确认）` : '待确认') : `+${analysis.leadTimeDays} 工作日`}</strong></div><div><span>交期口径</span><strong>{caseRecord.commitment || '未设置承诺口径'}</strong></div><small>合成示意 · 估计排期，最终以检测机构确认</small></section>
    <div className="workspace-grid"><div className="workspace-main">
      <section id="case-config" className="case-config-section"><div className="section-heading"><div><span className="overline">配置对照</span><h2>客户改了什么</h2></div><span className="synthetic-label">合成演示数据</span></div><div className="config-compare"><ConfigCard title="报告基线" config={base} /><div className="compare-arrow"><ArrowUpRight size={19} /><span>客户变更</span></div><ConfigCard title="待核验配置" config={requested} editable={!caseLoading} accent onChange={updateDraft} /></div><section className="commercial-strip"><div className="commercial-title"><span>报价基线</span><strong>把数量和单价一起带入业务账单</strong></div><Field label="订单数量" value={quantity} type="number" onChange={(value) => { setQuantity(value === '' ? 0 : Number(value)); setDirty(true); }} readOnly={caseLoading} /><Field label="当前单价（EUR）" value={unitPriceEur} type="number" onChange={(value) => { setUnitPriceEur(value === '' ? 0 : Number(value)); setDirty(true); }} readOnly={caseLoading} /><span className="commercial-total">货值小计 <strong>{formatEuro(quantity * unitPriceEur)}</strong></span></section></section>
      <section id="case-bill" className="bill-panel"><div className="bill-head"><div><span className="overline">合规账单 · {analysis?.ruleVersion || '等待推演'}</span><h2>这次改动要付出什么</h2></div><div className="bill-total"><span>预估补测与更新</span><strong>{totalCostLabel}</strong>{costNeedsReview ? <small>已知费用小计 {knownCostEur !== null && knownCostEur > 0 ? formatEuro(knownCostEur) : '部分费用待核验'}</small> : <small>{analysis?.leadTimeDays !== null && analysis?.leadTimeDays !== undefined ? `+${analysis.leadTimeDays} 工作日` : analysis ? '交期待核验' : '等待推演'}</small>}</div></div>{analysis ? <><div className="bill-summary"><div><span>需补测</span><strong>{retest.length}</strong></div><div><span>可沿用</span><strong>{reused.length}</strong></div><div><span>需更新</span><strong>{update.length}</strong></div><div className={review.length ? 'summary-risk' : ''}><span>待人工核验</span><strong>{review.length}</strong></div></div><div id="case-evidence" className="finding-list">{analysis.findings.map((finding) => <FindingRow key={finding.id} finding={finding} reports={reports} onEvidence={onEvidence} />)}</div><div className="formula-note"><Clock3 size={15} /><span>排期估算：{analysis.calculation.preparationDays ? `${analysis.calculation.preparationDays} 天打样串行；` : ''}测试并行 {analysis.calculation.parallelDays} 天，文件更新 {analysis.calculation.documentationDays} 天；总计约 {analysis.calculation.estimatedDays ?? analysis.leadTimeDays ?? '待核验'} 工作日{review.length || analysis.leadTimeDays === null ? '（待人工确认）' : ''}。{analysis.calculation.formula}</span><span className="formula-rule">规则 {analysis.ruleVersion}</span></div></> : <div id="case-evidence" className="analysis-empty"><Sparkles size={20} /><div><strong>准备开始覆盖推理</strong><span>编辑右侧客户配置后，点击“重新推演”，系统会逐项核对报告范围。</span></div><button className="button button-primary button-small" onClick={onAnalyze} disabled={busy === 'analyze'}>运行第一次推演</button></div>}</section>
      <section id="case-quote" className="alternatives-section"><div className="section-heading"><div><span className="overline">报价选择</span><h2>把合规代价带回客户对话</h2></div><span className="muted">方案会基于同一套规则重新计算</span></div>{analysis ? (analysis.alternatives.length > 0 ? <div className="alternative-grid">{analysis.alternatives.map((alternative) => <article className={`alternative-card ${alternative.id === 'A' ? 'recommended' : ''}`} key={alternative.id}><div className="alternative-head"><span className="alternative-code">方案 {alternative.id}</span>{alternative.id === 'A' && <span className="recommended-label">风险更低</span>}</div><h3>{alternative.label}</h3><p>{alternative.summary}</p><div className="alternative-stats"><span><small>预计费用</small><strong>{alternativeCostLabel(alternative)}</strong></span><span><small>交期影响</small><strong>{alternative.leadTimeDays === null ? (alternative.estimatedLeadTimeDays ? `约 +${alternative.estimatedLeadTimeDays} 天（待确认）` : '待确认') : `+${alternative.leadTimeDays} 天`}</strong></span></div><button className={`button ${alternative.id === 'A' ? 'button-primary' : 'button-secondary'} full-button`} onClick={() => chooseAlternative(alternative)} disabled={caseLoading || busy === 'chat' || busy === 'save'}>选择方案 {alternative.id} 并重算 <ArrowUpRight size={15} /></button></article>)}</div> : <div className="empty-inline">当前配置没有可行的替代方案，按当前配置继续。</div>) : <div className="empty-inline">完成一次推演后，这里会显示基于实际配置计算的替代方案。</div>}</section>
    </div><aside className="workspace-aside"><section className="conversation-panel"><div className="conversation-head"><div><span className="title-meta">工作流 01 · 外贸业务</span><h2>客户对话</h2></div><span className="round-badge">R{caseRecord.round}</span></div><div className="conversation-context"><MessageSquare size={15} /><span>当前共享上下文：{requested.model || 'NL-L'} · {requested.powerW ?? '?'}W · {requested.ip || 'IP?'}</span></div><div className="message-list">{caseRecord.messages.length === 0 && <div className="empty-conversation"><Inbox size={22} /><p>输入客户的下一句要求，系统会重新推演，而不是只改文案。</p></div>}{caseRecord.messages.slice(-6).map((item) => <div className={`message ${item.role}`} key={item.id}><div className="message-avatar">{item.role === 'user' ? '买' : 'TT'}</div><div><span className="message-author">{item.role === 'user' ? '客户 / 业务员' : 'TradeTwin AI'} {item.mode && <em>{item.mode}</em>}</span><p>{item.content}</p></div></div>)}</div><div className="suggestion-row">{primaryAlternative && <button disabled={caseLoading} onClick={() => setMessage(`客户选择方案 A（${primaryAlternative.config.powerW ?? '?'}W / ${primaryAlternative.config.ip ?? 'IP?'}），请重新计算并不要承诺具体交期。`)}>选择 A · {primaryAlternative.config.powerW ?? '?'}W / {primaryAlternative.config.ip ?? 'IP?'}</button>}<button disabled={caseLoading} onClick={() => setMessage('把驱动电源换成 DRV-B，告诉我 EMC 是否还能沿用。')}>换驱动 · 看 EMC</button></div><div className="composer"><textarea aria-label="输入客户变更" value={message} disabled={caseLoading} onChange={(event) => setMessage(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void send(); } }} placeholder="例如：客户希望改成 30W / IP44，但不要承诺原交期…" rows={3} /><div className="composer-foot"><label className="channel-select"><span>输出</span><select value={channel} disabled={caseLoading} onChange={(event) => setChannel(event.target.value as Channel)}><option value="email">商务邮件</option><option value="rfq">RFQ 回复</option></select><ChevronDown size={13} /></label><button className="send-button" onClick={() => void send()} disabled={caseLoading || busy === 'chat' || busy === 'save' || !message.trim()} aria-label="发送消息">{busy === 'chat' ? <Loader2 size={17} className="spin" /> : <Send size={17} />}</button></div></div></section><section className="quote-panel"><div className="quote-head"><div><span className="title-meta">工作流 02 · 输出</span><h2>本地化报价</h2></div><div className="quote-tabs" role="tablist"><button className={tab === 'bill' ? 'active' : ''} disabled={caseLoading} onClick={() => setTab('bill')}>内部待办</button><button className={tab === 'reply' ? 'active' : ''} disabled={caseLoading} onClick={() => setTab('reply')}>英德回复</button></div></div>{tab === 'bill' ? <InternalTasks analysis={analysis} quote={caseRecord.quote} /> : <LocalizedQuote quote={caseRecord.quote} channel={channel} onGenerate={() => { void generateQuote(); }} busy={caseLoading || busy === 'quote' || busy === 'save'} />}</section></aside></div>
  </div>;
}

function InternalTasks({ analysis, quote }: { analysis: AnalysisResult | null; quote: QuoteResult | null }) {
  if (!analysis) return <div className="empty-inline">完成一次推演后，业务、品质、采购会收到各自的下一步。</div>;
  const internal = quote?.internal;
  const qualityTasks = analysis.findings.filter((item) => item.status === 'retest' || item.status === 'review').map((item) => `${item.title} · ${item.status === 'review' ? '待人工复核' : '补测'}`);
  const procurementPlan = analysis.calculation.preparationDays ? [`先完成 ${analysis.calculation.preparationDays} 天打样（串行），再进入测试并行与文件更新；内部估算仍待确认。`] : [];
  return <div className="task-columns"><div><span className="task-role sales">业务</span><ul>{(internal?.sales?.length ? internal.sales : [`${analysis.alternatives.length} 个报价选项待确认`, analysis.warnings.length ? '先核对承诺风险' : '可准备双语回复', '客户第二轮选择后重新推演']).map((item, index) => <li key={`sales-${index}`}>{item}</li>)}</ul></div><div><span className="task-role quality">品质</span><ul>{(internal?.quality?.length ? internal.quality : [...(qualityTasks.length ? qualityTasks : ['当前无新增补测']), analysis.documentUpdates.length ? `${analysis.documentUpdates.length} 项文件需更新` : '文件无需更新']).map((item, index) => <li key={`quality-${index}`}>{item}</li>)}</ul></div><div><span className="task-role procurement">采购</span><ul>{(internal?.procurement?.length ? internal.procurement : ['核对驱动与材料证据', analysis.reviewCount ? `${analysis.reviewCount} 项待人工确认` : '暂无人工待办', ...procurementPlan]).map((item, index) => <li key={`procurement-${index}`}>{item}</li>)}</ul></div></div>;
}

function LocalizedQuote({ quote, channel, onGenerate, busy }: { quote: QuoteResult | null; channel: Channel; onGenerate: () => void; busy: boolean }) {
  if (!quote) return <div className="quote-empty"><Globe2 size={23} /><strong>生成一封能发出去的回复</strong><span>会根据账单生成英语、德语版本，并保留内部中文依据。</span><button className="button button-primary button-small" onClick={() => onGenerate()} disabled={busy}>{busy ? <Loader2 size={15} className="spin" /> : <Sparkles size={15} />} 生成 {channel === 'email' ? '商务邮件' : 'RFQ'} </button></div>;
  return <div className="quote-content"><div className="quote-mode"><span>{channel === 'email' ? '商务邮件' : 'Alibaba RFQ'} · {quote.modelMode === 'demo' ? '演示模板' : quote.modelMode}</span><span>{new Date(quote.generatedAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</span></div><article className="quote-language"><div className="lang-label">EN <span>English</span></div><p>{quote.en}</p></article><article className="quote-language"><div className="lang-label">DE <span>Deutsch</span></div><p>{quote.de}</p></article>{quote.warnings.length > 0 && <div className="quote-warning"><AlertTriangle size={15} /><span>{quote.warnings.join('；')}</span></div>}<button className="text-button" onClick={() => onGenerate()} disabled={busy}><RefreshCw size={14} /> 重新生成</button></div>;
}

function EvidenceView({ reports, onRefresh, onNotice }: { reports: EvidenceReport[]; onRefresh: () => void; onNotice: (notice: Notice) => void }) {
  const [query, setQuery] = useState(''); const [uploading, setUploading] = useState(false); const [selected, setSelected] = useState<EvidenceReport | null>(null);
  useEffect(() => { if (!selected) return; const refreshed = reports.find((report) => report.id === selected.id); if (refreshed && refreshed !== selected) setSelected(refreshed); }, [reports, selected]);
  const filtered = reports.filter((report) => `${report.id} ${report.title} ${report.filename}`.toLowerCase().includes(query.toLowerCase()));
  const upload = async (file: File) => { setUploading(true); const form = new FormData(); form.append('file', file); try { await api<EvidenceReport>('/api/reports', { method: 'POST', body: form }); onNotice({ kind: 'success', message: '报告已上传，抽取结果需要人工确认' }); await onRefresh(); } catch (error) { onNotice({ kind: 'error', message: error instanceof Error ? error.message : '报告上传失败' }); } finally { setUploading(false); } };
  return <div className="secondary-page"><section className="page-heading"><div><h1>证据库</h1><p>每条判断都要回到报告编号、页码和原文。上传内容仅作为不可信数据处理。</p></div><label className="button button-primary upload-button"><Upload size={16} /> {uploading ? '解析中…' : '上传报告'}<input type="file" accept=".pdf,.txt,.md,.json" onChange={(event) => { const file = event.target.files?.[0]; if (file) void upload(file); event.currentTarget.value = ''; }} disabled={uploading} /></label></section><div className="toolbar"><label className="search-field"><Search size={16} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索报告、型号或文件名" /></label><span className="toolbar-count">{filtered.length} 份报告 · 合成数据可见标注</span></div><div className="evidence-layout"><section className="report-list">{filtered.map((report) => <button className={`report-card ${selected?.id === report.id ? 'selected' : ''}`} key={report.id} onClick={() => setSelected(report)}><div className="report-icon"><FileText size={18} /></div><div className="report-copy"><div><strong>{report.id}</strong><StatusPill status={report.status} /></div><h3>{report.title}</h3><p>{report.filename} · {report.pageCount} 页</p><div className="report-tags">{report.coverage.tests.slice(0, 3).map((test) => <span key={test}>{test}</span>)}</div></div><ChevronRight size={17} /></button>)}{filtered.length === 0 && <div className="empty-state"><FolderOpen size={26} /><strong>还没有匹配报告</strong><span>可上传 PDF、Markdown 或文本报告。</span></div>}</section><ReportDetailEditable report={selected} onNotice={onNotice} onRefresh={onRefresh} /></div></div>;
}

function ReportDetail({ report, onNotice, onRefresh }: { report: EvidenceReport | null; onNotice: (notice: Notice) => void; onRefresh: () => void }) {
  const [verified, setVerified] = useState(false); const [notes, setNotes] = useState(''); const [saving, setSaving] = useState(false);
  useEffect(() => { setVerified(report?.verified ?? false); setNotes(report?.notes ?? ''); }, [report]);
  if (!report) return <aside className="detail-empty"><FileCheck2 size={28} /><strong>选择一份报告</strong><span>查看覆盖范围、页码证据，再确认是否可被规则使用。</span></aside>;
  const confirm = async () => { setSaving(true); try { await api(`/api/reports/${report.id}`, { method: 'PATCH', body: JSON.stringify({ verified, notes }) }); onNotice({ kind: 'success', message: `${report.id} 已保存人工确认状态` }); await onRefresh(); } catch (error) { onNotice({ kind: 'error', message: error instanceof Error ? error.message : '保存失败' }); } finally { setSaving(false); } };
  return <aside className="report-detail"><div className="detail-head"><div><span className="overline">报告详情 · {report.id}</span><h2>{report.title}</h2></div><StatusPill status={report.status} /></div>{report.source === 'synthetic' && <div className="synthetic-callout"><Sparkles size={15} /><span>这是合成演示报告。真实项目需以机构原文和工程师确认替换。</span></div>}<div className="coverage-block"><h4>覆盖范围摘要</h4><dl><div><dt>型号系列</dt><dd>{report.coverage.series || '未知'}</dd></div><div><dt>功率区间</dt><dd>{report.coverage.powerMinW ?? '?'}–{report.coverage.powerMaxW ?? '?'} W</dd></div><div><dt>防护等级</dt><dd>{report.coverage.ipLevels.join(' / ') || '未知'}</dd></div><div><dt>驱动 / 材料</dt><dd>{report.coverage.drivers.join(' / ') || '未知'} · {report.coverage.materials.join(' / ') || '未知'}</dd></div></dl></div><div className="page-evidence"><div className="section-heading compact"><h4>页码与原文</h4><a href={`/api/reports/${report.id}/file`} target="_blank" rel="noreferrer">打开文件 <ArrowUpRight size={13} /></a></div>{report.pages.slice(0, 4).map((page) => <div className="page-snippet" key={page.page}><span>p.{page.page}</span><p>{page.text || '未提取到文字，需要人工补录。'}</p></div>)}</div><div className="verify-form"><label className="check-row"><input type="checkbox" checked={verified} onChange={(event) => setVerified(event.target.checked)} /><span><strong>我已核对覆盖范围</strong><small>只有人工确认后，规则才会允许自动沿用。</small></span></label><textarea value={notes} onChange={(event) => setNotes(event.target.value)} placeholder="写下工程师的确认依据或限制…" rows={3} /><button className="button button-primary full-button" onClick={confirm} disabled={saving || !notes.trim()}>{saving ? <Loader2 size={15} className="spin" /> : <ClipboardCheck size={15} />} 保存确认</button></div></aside>;
}

function ReportDetailEditable({ report, onNotice, onRefresh }: { report: EvidenceReport | null; onNotice: (notice: Notice) => void; onRefresh: () => void }) {
  const [verified, setVerified] = useState(false);
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);
  const [coverage, setCoverage] = useState<Coverage>({ series: null, powerMinW: null, powerMaxW: null, ipLevels: [], drivers: [], materials: [], markets: [], tests: [], confidence: 0 });
  const [testScopes, setTestScopes] = useState<TestScopeMap>({});
  const [scopeTest, setScopeTest] = useState('');
  const [scopeCoverage, setScopeCoverage] = useState<Coverage>({ series: null, powerMinW: null, powerMaxW: null, ipLevels: [], drivers: [], materials: [], markets: [], tests: [], confidence: 0 });
  const [scopePage, setScopePage] = useState<number | ''>('');
  const [commonScopePage, setCommonScopePage] = useState<number | ''>('');
  const [scopeEditing, setScopeEditing] = useState(false);
  const pagesWithText = useMemo(() => report?.pages.filter((page) => page.text.trim()) ?? [], [report]);

  useEffect(() => {
    if (!report) return;
    const scopes = report.testScopes ?? {};
    const firstTest = Object.keys(scopes)[0] ?? report.coverage.tests[0] ?? '';
    const firstScope = firstTest ? scopes[firstTest] : undefined;
    setVerified(report.verified);
    setNotes(report.notes || '');
    setCoverage({ ...report.coverage, tests: [...report.coverage.tests] });
    setTestScopes(scopes);
    setScopeTest(firstTest);
    setScopeCoverage(firstScope ? { ...firstScope.coverage, tests: [...firstScope.coverage.tests] } : { ...report.coverage, tests: firstTest ? [firstTest] : [] });
    setScopePage(firstScope?.page ?? '');
    setCommonScopePage('');
    setScopeEditing(false);
  }, [report]);

  if (!report) return <aside className="detail-empty"><FileCheck2 size={28} /><strong>选择一份报告</strong><span>查看覆盖范围、页码证据，再确认是否可被规则使用。</span></aside>;

  const textList = (value: string) => value.split(',').map((item) => item.trim()).filter(Boolean);
  const knownTestIds = new Set(TEST_SCOPE_OPTIONS.map((item) => item.id));
  const selectableTests = Array.from(new Set([...TEST_SCOPE_OPTIONS.map((item) => item.id), ...coverage.tests, ...Object.keys(testScopes)]));
  const customTests = coverage.tests.filter((test) => !knownTestIds.has(test));
  const setList = (key: 'ipLevels' | 'drivers' | 'materials' | 'markets', value: string) => setCoverage((current) => ({ ...current, [key]: textList(value) }));
  const setScopeList = (key: 'ipLevels' | 'drivers' | 'materials' | 'markets', value: string) => { setScopeEditing(true); setScopeCoverage((current) => ({ ...current, [key]: textList(value) })); };
  const pageQuote = (pageNumber: number) => pagesWithText.find((page) => page.page === pageNumber)?.text.trim().slice(0, 4000);
  const scopeFromCoverage = (value: Coverage, test: string, page: number) => ({ coverage: { ...value, tests: [test] }, page, ...(pageQuote(page) ? { quote: pageQuote(page) } : {}) });
  const toggleTest = (test: string) => setCoverage((current) => ({ ...current, tests: current.tests.includes(test) ? current.tests.filter((item) => item !== test) : [...current.tests, test] }));
  const selectScopeTest = (test: string) => {
    const selected = testScopes[test];
    setScopeTest(test);
    setScopeEditing(false);
    setScopeCoverage(selected ? { ...selected.coverage, tests: [...selected.coverage.tests] } : { ...coverage, tests: test ? [test] : [] });
    setScopePage(selected?.page ?? '');
  };
  const updateScopePage = (value: string) => { setScopeEditing(true); setScopePage(value ? Number(value) : ''); };
  const confirm = async () => {
    if (report.status === 'failed') {
      onNotice({ kind: 'error', message: '解析失败的报告不能确认；请先补录并重新上传结构化 JSON。' });
      return;
    }
    if (!notes.trim()) return;
    const coverageChanged = JSON.stringify(coverage) !== JSON.stringify(report.coverage);
    const shouldApplyCommon = commonScopePage !== '' && coverage.tests.length > 0;
    if (verified && coverage.tests.length === 0) {
      onNotice({ kind: 'error', message: '确认覆盖范围前至少选择一个测试项目。' });
      return;
    }
    if (coverageChanged && coverage.tests.length > 0 && commonScopePage === '') {
      onNotice({ kind: 'error', message: '请先选择“范围依据页码”，明确把公共范围应用到勾选的测试项目。' });
      return;
    }
    if (shouldApplyCommon && scopeEditing) {
      onNotice({ kind: 'error', message: '公共范围应用与项目级范围编辑请分两次保存，避免覆盖彼此的项目条件。' });
      return;
    }
    if (scopeEditing && (!scopeTest || scopePage === '' || scopeCoverage.tests.length === 0)) {
      onNotice({ kind: 'error', message: '项目级范围编辑需要选择测试项目、含文字页码和至少一个测试项目。' });
      return;
    }
    const nextScopes: TestScopeMap = { ...testScopes };
    if (scopeEditing && scopeTest && scopePage !== '') nextScopes[scopeTest] = scopeFromCoverage(scopeCoverage, scopeTest, Number(scopePage));
    setSaving(true);
    try {
      const payload: Record<string, unknown> = { verified, notes, coverage };
      if (shouldApplyCommon) {
        // The API deliberately treats common-range application as a separate
        // operation from full testScopes editing. This makes the selected
        // projects and source page explicit and auditable.
        payload.scopePage = Number(commonScopePage);
        payload.scopeTests = coverage.tests;
      } else {
        payload.testScopes = nextScopes;
      }
      await api(`/api/reports/${report.id}`, { method: 'PATCH', body: JSON.stringify(payload) });
      onNotice({ kind: 'success', message: `${report.id} 已保存覆盖范围、项目独立范围与人工确认状态` });
      await onRefresh();
    } catch (error) {
      onNotice({ kind: 'error', message: error instanceof Error ? error.message : '保存失败，请检查覆盖范围字段' });
    } finally {
      setSaving(false);
    }
  };
  const scopeEntries = Object.entries(testScopes);
  const scopeDescription = (scope: TestScopeMap[string]) => `${scope.coverage.series || '系列未知'} · ${scope.coverage.powerMinW ?? '?'}–${scope.coverage.powerMaxW ?? '?'}W · ${scope.coverage.ipLevels.join('/') || 'IP未知'} · ${scope.coverage.drivers.join('/') || '驱动未知'} · p.${scope.page}`;

  return <aside className="report-detail">
    <div className="detail-head"><div><div className="title-meta">报告详情 · {report.id}</div><h2>{report.title}</h2></div><StatusPill status={report.status} /></div>
    {report.source === 'synthetic' && <div className="synthetic-callout"><Sparkles size={15} /><span>这是合成演示报告。真实项目需以机构原文和工程师确认替换。</span></div>}
    {report.status === 'failed' && <div className="failed-callout"><AlertTriangle size={15} /><div><strong>文件解析失败，当前不能确认</strong><span>无文字层的 PDF 不能成为可确认证据。请使用结构化 JSON / Markdown 补录真实页码与原文摘录，再重新上传；系统不会把失败文件当作合规证据。</span><code>示例路径：examples/report-coverage.json</code><details><summary>查看 JSON 结构示例</summary><pre>{FAILED_REPORT_JSON_EXAMPLE}</pre></details></div></div>}
    <div className="coverage-block"><h4>公共覆盖范围 · 可编辑草稿</h4><div className="coverage-form">
      <Field label="型号系列" value={coverage.series || ''} onChange={(value) => setCoverage((current) => ({ ...current, series: value || null }))} placeholder="未知可留空" />
      <Field label="最小功率（W）" value={coverage.powerMinW ?? ''} type="number" onChange={(value) => setCoverage((current) => ({ ...current, powerMinW: value === '' ? null : Number(value) }))} placeholder="未知可留空" />
      <Field label="最大功率（W）" value={coverage.powerMaxW ?? ''} type="number" onChange={(value) => setCoverage((current) => ({ ...current, powerMaxW: value === '' ? null : Number(value) }))} placeholder="未知可留空" />
      <Field label="防护等级（逗号分隔）" value={coverage.ipLevels.join(', ')} onChange={(value) => setList('ipLevels', value)} placeholder="例如 IP20, IP44" />
      <Field label="驱动电源" value={coverage.drivers.join(', ')} onChange={(value) => setList('drivers', value)} placeholder="例如 DRV-A" />
      <Field label="材料组合" value={coverage.materials.join(', ')} onChange={(value) => setList('materials', value)} placeholder="未知可留空" />
      <Field label="目标市场" value={coverage.markets.join(', ')} onChange={(value) => setList('markets', value)} placeholder="例如 DE" />
    </div>
      <div className="scope-test-picker"><span className="field-label">公共范围将应用到的测试项目</span><div className="test-check-grid">{selectableTests.map((test) => <label className="test-check" key={test}><input type="checkbox" checked={coverage.tests.includes(test)} onChange={() => toggleTest(test)} disabled={report.status === 'failed'} /><span>{TEST_SCOPE_LABELS[test] || test}</span></label>)}</div><Field label="其他项目 ID（逗号分隔）" value={customTests.join(', ')} onChange={(value) => setCoverage((current) => ({ ...current, tests: [...current.tests.filter((test) => knownTestIds.has(test)), ...textList(value)] }))} placeholder="例如 photobiological" /></div>
      <label className="field scope-page-field"><span>范围依据页码</span><select value={commonScopePage === '' ? '' : String(commonScopePage)} onChange={(event) => setCommonScopePage(event.target.value ? Number(event.target.value) : '')} disabled={report.status === 'failed' || pagesWithText.length === 0}><option value="">请选择含文字的报告页</option>{pagesWithText.map((page) => <option value={page.page} key={page.page}>第 {page.page} 页 · {page.text.trim().slice(0, 72)}</option>)}</select><small>保存时会把公共范围应用到上面勾选的项目，并覆盖这些项目的独立范围；请核对来源。</small></label>
    </div>
    {scopeEntries.length > 0 && <div className="scope-block"><div className="scope-block-head"><h4>测试项目独立覆盖范围</h4><span>{scopeEntries.length} 项 · 推演按此处优先</span></div><div className="scope-list">{scopeEntries.map(([test, scope]) => <button className={`scope-row ${scopeTest === test ? 'active' : ''}`} key={test} onClick={() => selectScopeTest(test)}><strong>{TEST_SCOPE_LABELS[test] || test}</strong><span>{scopeDescription(scope)}</span></button>)}</div><div className="scope-editor"><div className="scope-editor-head"><strong>编辑项目范围</strong><span>保存后将影响下一次推演。</span></div><label className="field"><span>测试项目</span><select value={scopeTest} onChange={(event) => selectScopeTest(event.target.value)}><option value="">请选择项目</option>{selectableTests.map((test) => <option value={test} key={test}>{TEST_SCOPE_LABELS[test] || test}</option>)}</select></label><div className="coverage-form"><Field label="型号系列" value={scopeCoverage.series || ''} onChange={(value) => { setScopeEditing(true); setScopeCoverage((current) => ({ ...current, series: value || null })); }} placeholder="未知可留空" /><Field label="最小功率（W）" value={scopeCoverage.powerMinW ?? ''} type="number" onChange={(value) => { setScopeEditing(true); setScopeCoverage((current) => ({ ...current, powerMinW: value === '' ? null : Number(value) })); }} placeholder="未知可留空" /><Field label="最大功率（W）" value={scopeCoverage.powerMaxW ?? ''} type="number" onChange={(value) => { setScopeEditing(true); setScopeCoverage((current) => ({ ...current, powerMaxW: value === '' ? null : Number(value) })); }} placeholder="未知可留空" /><Field label="防护等级" value={scopeCoverage.ipLevels.join(', ')} onChange={(value) => setScopeList('ipLevels', value)} placeholder="例如 IP20" /><Field label="驱动电源" value={scopeCoverage.drivers.join(', ')} onChange={(value) => setScopeList('drivers', value)} placeholder="例如 DRV-A" /><Field label="材料组合" value={scopeCoverage.materials.join(', ')} onChange={(value) => setScopeList('materials', value)} placeholder="未知可留空" /><Field label="目标市场" value={scopeCoverage.markets.join(', ')} onChange={(value) => setScopeList('markets', value)} placeholder="例如 DE" /></div><label className="field scope-page-field"><span>项目范围依据页码</span><select value={scopePage === '' ? '' : String(scopePage)} onChange={(event) => updateScopePage(event.target.value)} disabled={report.status === 'failed' || pagesWithText.length === 0}><option value="">请选择含文字的报告页</option>{pagesWithText.map((page) => <option value={page.page} key={page.page}>第 {page.page} 页 · {page.text.trim().slice(0, 72)}</option>)}</select></label></div></div>}
    {scopeEntries.length === 0 && <div className="scope-block scope-empty"><h4>尚无项目级独立范围</h4><p>在上方勾选测试项目并选择“范围依据页码”后保存，系统会为每个项目写入独立范围；规则引擎不会把公共摘要当作项目证据。</p></div>}
    <div className="page-evidence"><div className="section-heading compact"><h4>页码与原文</h4><a href={`/api/reports/${report.id}/file`} target="_blank" rel="noreferrer">打开文件 <ArrowUpRight size={13} /></a></div>{report.pages.slice(0, 4).map((page) => <div className="page-snippet" key={page.page}><span>p.{page.page}</span><p>{page.text || '未提取到文字，需要人工补录。'}</p></div>)}</div>
    <div className="verify-form"><label className="check-row"><input type="checkbox" checked={verified} disabled={report.status === 'failed'} onChange={(event) => setVerified(event.target.checked)} /><span><strong>我已核对覆盖范围</strong><small>{report.status === 'failed' ? '解析失败文件不可确认，请先上传结构化补录。' : '只有人工确认后，规则才会允许自动沿用。'}</small></span></label><textarea value={notes} onChange={(event) => setNotes(event.target.value)} placeholder="写下工程师的确认依据或限制…" rows={3} /><button className="button button-primary full-button" onClick={confirm} disabled={saving || !notes.trim() || report.status === 'failed'}>{saving ? <Loader2 size={15} className="spin" /> : <ClipboardCheck size={15} />} {report.status === 'failed' ? '解析失败，不可确认' : '保存确认草稿'}</button></div>
  </aside>;
}

const AUDIT_TYPE_LABELS: Record<string, string> = {
  'case.created': '创建案件',
  'case.updated': '更新配置',
  'analysis.completed': '完成规则推演',
  'chat.completed': '客户对话重算',
  'quote.generated': '生成双语报价',
  'finding.override': '人工覆盖判断',
  'evidence.changed': '证据变更',
  'knowledge.researched': '知识索引核查',
  'knowledge.changed': '知识更新 · 待重新推演',
};

function parseAuditDetail(detail: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(detail);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function auditConfigSummary(value: unknown): string {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return '';
  const config = value as Partial<ProductConfig>;
  return [config.model, config.powerW === null || config.powerW === undefined ? '' : `${config.powerW}W`, config.ip, config.driver, config.material, config.market]
    .filter(Boolean).join(' · ');
}

function auditEventSummary(event: AuditEvent): string {
  const detail = parseAuditDetail(event.detail);
  if (!detail) return event.detail || '没有可显示的摘要。';
  const config = auditConfigSummary(detail.config);
  const retrievalCount = Array.isArray(detail.retrievalIds) ? detail.retrievalIds.length : 0;
  switch (event.type) {
    case 'case.created': return `案件「${String(detail.name || '未命名')}」 · 买家 ${String(detail.buyer || '未填写')}`;
    case 'case.updated': return `客户配置已更新${config ? `：${config}` : ''}${detail.commitment ? ` · 交期口径：${String(detail.commitment)}` : ''}`;
    case 'analysis.completed': return `完成 ${String(detail.findingCount ?? 0)} 项规则判断${config ? ` · ${config}` : ''}`;
    case 'chat.completed': return `${String(detail.summary || '客户消息已处理并重新推演')}${detail.mode ? ` · ${String(detail.mode)}` : ''}${retrievalCount ? ` · 引用知识 ${retrievalCount} 条` : ''}`;
    case 'quote.generated': return `已生成${detail.channel === 'rfq' ? ' RFQ' : '商务邮件'} · 模型模式 ${String(detail.mode || '未知')}${retrievalCount ? ` · 引用知识 ${retrievalCount} 条` : ''}`;
    case 'finding.override': return `${detail.decision === 'accept' ? '接受' : '驳回'} ${String(detail.findingId || '当前判断')} · 操作者 ${String(detail.actor || event.actor)} · 理由：${String(detail.reason || '未填写')}`;
    case 'evidence.changed': return `证据${detail.reportId ? ` ${String(detail.reportId)}` : ''}已变更，相关案件需要重新推演${detail.status ? ` · 状态 ${String(detail.status)}` : ''}`;
    case 'knowledge.changed': return `运行时知识已更新${detail.version ? ` · 版本 ${String(detail.version)}` : ''}，旧推演已清除，请重新推演`;
    default: return `记录字段：${Object.keys(detail).slice(0, 4).join('、') || '无'}`;
  }
}

function AuditView({ cases, onNotice }: { cases: CaseRecord[]; onNotice: (notice: Notice) => void }) {
  const [events, setEvents] = useState<AuditEvent[]>([]); const [loading, setLoading] = useState(true); const [caseId, setCaseId] = useState(cases[0]?.id || '');
  useEffect(() => { if (!caseId) return; setLoading(true); void api<AuditEvent[]>(`/api/audit?caseId=${encodeURIComponent(caseId)}`).then(setEvents).catch((error) => onNotice({ kind: 'error', message: error instanceof Error ? error.message : '审计读取失败' })).finally(() => setLoading(false)); }, [caseId]);
  return <div className="secondary-page"><section className="page-heading"><div><h1>审计记录</h1><p>记录推演指纹、规则版本、模型模式与人工覆盖，不静默改写结论。</p></div><label className="select-field"><span>案件</span><select value={caseId} onChange={(event) => setCaseId(event.target.value)}>{cases.map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}</select><ChevronDown size={14} /></label></section>{loading ? <LoadingState /> : <div className="audit-list">{events.map((event) => <article className="audit-row" key={event.id}><div className="audit-time">{new Date(event.createdAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}</div><div className="audit-dot" /><div className="audit-copy"><div><strong>{AUDIT_TYPE_LABELS[event.type] || event.type}</strong><span>{event.actor} · 规则 {event.ruleVersion}</span></div><p>{auditEventSummary(event)}</p><details><summary>查看原始记录</summary><pre>{event.detail}</pre>{event.fingerprint && <code>推演指纹：{event.fingerprint}</code>}</details></div></article>)}{events.length === 0 && <div className="empty-state"><History size={26} /><strong>暂无审计事件</strong><span>运行一次推演或人工确认后会出现在这里。</span></div>}</div>}</div>;
}

function formatModelTestStatus(status: unknown): string {
  if (typeof status === 'string' && status.trim()) return status;
  if (!status || typeof status !== 'object' || Array.isArray(status)) return '未返回状态';
  const value = status as Record<string, unknown>;
  const mode = value.mode === 'live' ? '真实 API' : value.mode === 'demo' ? '本地演示' : '';
  const modelValue = [value.model, value.modelName, value.officialModel, value.name].find((item): item is string => typeof item === 'string' && item.trim().length > 0);
  const model = modelValue || '';
  const configured = typeof value.configured === 'boolean' ? (value.configured ? '已配置' : '未配置') : '';
  return [mode, model, configured].filter(Boolean).join(' · ') || '已返回模型状态';
}

function SettingsView({ model, rules, costs, onNotice }: { model?: BootstrapData['model']; rules: BootstrapData['rules']; costs: BootstrapData['costs']; onNotice: (notice: Notice) => void }) {
  const [testing, setTesting] = useState(false); const [testResult, setTestResult] = useState<{ ok: boolean; status?: unknown; message?: string } | null>(null); const test = async () => { setTesting(true); setTestResult(null); try { const result = await api<{ ok: boolean; status?: unknown; message?: string }>('/api/model/test', { method: 'POST' }); setTestResult(result); onNotice({ kind: result.ok ? 'success' : 'error', message: result.message || (result.ok ? '模型连接测试完成' : '模型连接测试失败') }); } catch (error) { const message = error instanceof Error ? error.message : '连接测试失败'; setTestResult({ ok: false, message }); onNotice({ kind: 'error', message }); } finally { setTesting(false); } };
  return <div className="secondary-page"><section className="page-heading"><div><div className="title-meta">Runtime & model</div><h1>接入设置</h1><p>模型只负责理解与表达，测试结果、费用和证据由规则与人工确认控制。</p></div><button className="button button-primary" onClick={test} disabled={testing}>{testing ? <Loader2 size={15} className="spin" /> : <Bot size={16} />} 测试模型连接</button></section><div className="settings-grid"><section className="settings-card model-settings"><div className="settings-card-head"><div className="settings-icon"><Bot size={18} /></div><div><h2>模型适配器</h2><p>服务端 OpenAI 兼容接口</p></div><StatusPill status={model?.mode || 'demo'} /></div><dl className="settings-list"><div><dt>当前模式</dt><dd>{model?.mode === 'live' ? '真实 API' : '本地演示模板'}</dd></div><div><dt>模型名</dt><dd>{model?.model || '未配置'}</dd></div><div><dt>知识库挂载</dt><dd>{model?.vaultConfigured ? 'Obsidian 已配置（只读）' : '未配置，使用项目内知识'}</dd></div>{testResult && <div className={testResult.ok ? 'test-result ok' : 'test-result fail'}><dt>最近测试</dt><dd>{testResult.ok ? formatModelTestStatus(testResult.status) : testResult.message || '失败'}</dd></div>}</dl><div className="settings-callout"><ShieldAlert size={15} /><span>不配置密钥也可以演示规则引擎。回复会明确标注演示或回退模式。</span></div></section><section className="settings-card"><div className="settings-card-head"><div className="settings-icon green"><ClipboardCheck size={18} /></div><div><h2>规则版本</h2><p>推演可复现，证据需要回溯</p></div></div><div className="rule-count"><strong>{rules.length}</strong><span>条已登记规则</span></div><div className="mini-rule-list">{rules.slice(0, 5).map((rule) => <div key={rule.id}><span>{rule.id}</span><strong>{rule.title}</strong></div>)}</div></section><section className="settings-card cost-card"><div className="settings-card-head"><div className="settings-icon amber"><PackageCheck size={18} /></div><div><h2>费用与周期</h2><p>合成示意数据 · EUR / 工作日</p></div></div>{costs.map((cost) => <div className="cost-line" key={cost.id}><span>{cost.title}</span><strong>{cost.feeEur ? formatEuro(cost.feeEur) : '内部'}</strong><small>{cost.days} 天</small></div>)}</section></div></div>;
}

function NewCaseDialog({ onClose, onCreate, busy }: { onClose: () => void; onCreate: (payload: { name: string; buyer: string; inquiry: string }) => void; busy: boolean }) {
  const [name, setName] = useState(''); const [buyer, setBuyer] = useState(''); const [inquiry, setInquiry] = useState('');
  const dialogRef = useRef<HTMLElement | null>(null);
  useDialogAccessibility(dialogRef, onClose);
  const portalTarget = document.getElementById('dialog-root') || document.body;
  return createPortal(<div className="dialog-backdrop" data-dialog-portal onClick={onClose}><section ref={dialogRef} className="new-case-dialog" role="dialog" aria-modal="true" aria-labelledby="new-case-dialog-title" tabIndex={-1} onClick={(event) => event.stopPropagation()}><div className="dialog-head"><div><h2 id="new-case-dialog-title">建立一个变更案件</h2><p>先保存买家原话，稍后再补充配置参数。</p></div><IconButton label="关闭新建案件" onClick={onClose} initialFocus><X size={18} /></IconButton></div><Field label="案件名称" value={name} onChange={setName} placeholder="例如：NL-L 德国买家变更" autoFocus /><Field label="买家 / 公司" value={buyer} onChange={setBuyer} placeholder="例如：Nordlicht GmbH" /><label className="field"><span>客户原话 / 询盘</span><textarea value={inquiry} onChange={(event) => setInquiry(event.target.value)} rows={4} placeholder="例如：请把额定功率改为 36W，并提升到 IP44…" /></label><div className="dialog-actions"><button className="button button-secondary" onClick={onClose}>取消</button><button className="button button-primary" disabled={busy || !name.trim() || !buyer.trim()} onClick={() => onCreate({ name, buyer, inquiry })}>{busy ? <Loader2 size={15} className="spin" /> : <Plus size={15} />} 创建案件</button></div></section></div>, portalTarget);
}

function UnsavedChangesDialog({ onCancel, onDiscard }: { onCancel: () => void; onDiscard: () => void }) {
  const dialogRef = useRef<HTMLElement | null>(null);
  useDialogAccessibility(dialogRef, onCancel);
  return createPortal(<div className="dialog-backdrop" data-dialog-portal onClick={onCancel}><section ref={dialogRef} className="new-case-dialog" role="dialog" aria-modal="true" aria-labelledby="unsaved-title" aria-describedby="unsaved-description" tabIndex={-1} onClick={(event) => event.stopPropagation()}><div className="dialog-head"><h2 id="unsaved-title">配置尚未保存</h2></div><p id="unsaved-description" className="unsaved-description">离开会放弃当前未保存的配置。你可以继续编辑，保存后再离开。</p><div className="dialog-actions"><button className="button button-primary" data-dialog-initial-focus onClick={onCancel}>继续编辑</button><button className="button button-secondary discard-button" onClick={onDiscard}>放弃修改并离开</button></div></section></div>, document.getElementById('dialog-root') || document.body);
}

import { useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, ExternalLink, Loader2, RefreshCw, Workflow } from 'lucide-react';

export type WorkflowOneResult = {
  session_id?: string;
  shared_case_id?: string;
  workflow1QuoteReady?: boolean;
  sync_status?: 'syncing' | 'synced' | 'error';
  [key: string]: unknown;
};

type HealthState = 'loading' | 'ready' | 'error';

type SalesWorkspaceProps = {
  sessionId?: string | null;
  onRefreshCase: () => void;
  onOpenCase: (caseId: string) => void;
};

export default function SalesWorkspace({ sessionId, onRefreshCase, onOpenCase }: SalesWorkspaceProps) {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const latestSyncRevision = useRef(-1);
  const [health, setHealth] = useState<HealthState>('loading');
  const [healthMessage, setHealthMessage] = useState('正在检查工作流一服务…');
  const [frameLoaded, setFrameLoaded] = useState(false);
  const [frameError, setFrameError] = useState(false);
  const [result, setResult] = useState<WorkflowOneResult | null>(null);

  const source = useMemo(() => {
    if (!sessionId) return '/sales/';
    return `/sales/?session_id=${encodeURIComponent(sessionId)}`;
  }, [sessionId]);

  const checkHealth = async () => {
    setHealth('loading');
    setHealthMessage('正在检查工作流一服务…');
    try {
      const response = await fetch('/api/workflow1/health', { headers: { Accept: 'application/json' } });
      const payload = await response.json().catch(() => null) as { ok?: boolean; message?: string } | null;
      if (!response.ok || payload?.ok === false) throw new Error(payload?.message || `服务返回 ${response.status}`);
      setHealth('ready');
      setHealthMessage('工作流一服务已连接');
    } catch (error) {
      setHealth('error');
      setHealthMessage(error instanceof Error ? error.message : '工作流一服务暂不可用');
    }
  };

  useEffect(() => { void checkHealth(); }, []);
  useEffect(() => { setResult(null); setFrameLoaded(false); setFrameError(false); latestSyncRevision.current = -1; }, [sessionId]);
  useEffect(() => {
    const onMessage = (event: MessageEvent<unknown>) => {
      if (event.origin !== window.location.origin || event.source !== iframeRef.current?.contentWindow) return;
      if (!event.data || typeof event.data !== 'object') return;
      const payload = event.data as Record<string, unknown>;
      if (payload.type !== 'tradetwin:workflow1-result') return;
      const session = typeof payload.session_id === 'string' ? payload.session_id : undefined;
      const sharedCase = typeof payload.shared_case_id === 'string' ? payload.shared_case_id : undefined;
      if (!session && !sharedCase) return;
      const revision = typeof payload.sync_revision === 'number' ? payload.sync_revision : 0;
      if (revision < latestSyncRevision.current) return;
      latestSyncRevision.current = revision;
      setResult({ ...payload, session_id: session, shared_case_id: sharedCase,
        sync_status: payload.sync_status === 'syncing' || payload.sync_status === 'error' ? payload.sync_status : 'synced' });
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  const sharedCaseId = result?.shared_case_id || result?.session_id;
  const handoffBlocked = result?.sync_status === 'syncing' || result?.sync_status === 'error';

  return <div className="sales-workspace-page">
    <section className="sales-workspace-heading">
      <div>
        <div className="title-meta"><Workflow size={14} /> 工作流一 · 外贸业务</div>
        <h1>变更理解与报价选项</h1>
        <p>先理解买家变更，再核验证据与补测代价，最后形成报价选项和英德回复；业务与品质使用同一案件配置。</p>
      </div>
      <div className={`sales-health sales-health-${health}`} role="status">
        {health === 'loading' ? <Loader2 size={14} className="spin" /> : health === 'ready' ? <CheckCircle2 size={14} /> : <AlertTriangle size={14} />}
        <span>{healthMessage}</span>
        {health === 'error' && <button type="button" className="icon-button" aria-label="重试工作流一健康检查" title="重试健康检查" onClick={() => void checkHealth()}><RefreshCw size={14} /></button>}
      </div>
    </section>
    {result && <section className="sales-result-handoff" role="status">
      <div><strong>{result.sync_status === 'syncing' ? '正在计算并同步当前版本…' : result.sync_status === 'error' ? '当前版本尚未同步，请在工作台重试' : result.workflow1QuoteReady ? '报价数据已同步' : '已同步，等待证据/参数确认'}</strong><span>{result.session_id ? `会话 ${result.session_id}` : '已收到结果'}{typeof result.pending_reason === 'string' && result.pending_reason ? ` · ${result.pending_reason}` : ''}{typeof result.message === 'string' && result.message ? ` · ${result.message}` : ''}</span></div>
      <div className="sales-result-actions"><button type="button" className="button button-secondary button-small" disabled={handoffBlocked} onClick={onRefreshCase}><RefreshCw size={14} /> 刷新案件数据</button>{sharedCaseId && <button type="button" className="button button-primary button-small" disabled={handoffBlocked} onClick={() => onOpenCase(sharedCaseId)}><ExternalLink size={14} /> 打开品质核验</button>}</div>
    </section>}
    {frameError && <div className="sales-frame-error" role="alert"><AlertTriangle size={18} /><div><strong>业务工作台无法载入</strong><span>请确认本地服务已启动，再重试。</span></div><button type="button" className="button button-secondary button-small" onClick={() => { setFrameError(false); setFrameLoaded(false); if (iframeRef.current) iframeRef.current.src = source; void checkHealth(); }}><RefreshCw size={14} /> 重试</button></div>}
    <div className={`sales-frame-shell ${frameLoaded ? 'is-loaded' : ''} ${frameError ? 'has-error' : ''}`}>
      {!frameLoaded && !frameError && <div className="sales-frame-loading"><Loader2 size={20} className="spin" /><span>正在载入工作流一…</span></div>}
      <iframe ref={iframeRef} className="sales-frame" src={source} title="工作流一：变更理解与报价选项" onLoad={() => setFrameLoaded(true)} onError={() => setFrameError(true)} />
    </div>
  </div>;
}

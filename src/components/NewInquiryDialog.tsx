import { useEffect, useRef, useState, type FormEvent } from 'react';
import { createPortal } from 'react-dom';
import { Loader2, Plus, RefreshCw, Settings2, X } from 'lucide-react';
import type { CaseRecord, Channel } from '../../shared/types';
import { useDialogAccessibility } from './dialogAccessibility';

type MailSettings = {
  imap_host: string;
  imap_port: number;
  user: string;
  drafts_folder: string;
  signature: string;
  has_password: boolean;
  source?: 'ui' | 'env' | 'none';
};

type MailStatus = { mode: 'imap' | 'offline'; address?: string; error?: string };
type MailThread = {
  thread_id: string; subject: string; buyer_name: string; buyer_addr: string; message_count: number;
  inbound_count: number; updated_at: string; last_message_id: string; preview: string;
};
type MailThreadPreview = {
  thread_id: string; subject: string;
  messages: Array<{ message_id: string; from_name: string; from_email: string; date: string; body_clean: string }>;
};
type ExtensionCapture = {
  id: string; sessionId: string; sourceUrl: string; createdAt: string; expiresAt: string; status: 'pending' | 'imported';
};
type ExtensionCapturePreview = ExtensionCapture & { text: string };
type MailForm = Pick<MailSettings, 'imap_host' | 'imap_port' | 'user' | 'drafts_folder' | 'signature'> & { password: string };
type Notice = { kind: 'error' | 'success' | 'info'; message: string } | null;

const PRESETS: Record<string, { host: string; help: string }> = {
  qq: { host: 'imap.qq.com', help: 'QQ 邮箱网页端开启 IMAP 服务，并使用生成的授权码。' },
  '163': { host: 'imap.163.com', help: '163 邮箱网页端开启 IMAP 服务，并使用新增的授权密码。' },
  '126': { host: 'imap.126.com', help: '126 邮箱网页端开启 IMAP 服务，并使用新增的授权密码。' },
  exmail: { host: 'imap.exmail.qq.com', help: '腾讯企业邮需开启 IMAP；安全登录时使用客户端专用密码。' },
  aliyun: { host: 'imap.qiye.aliyun.com', help: '阿里企业邮需开启 IMAP，使用邮箱密码或客户端安全密码。' },
  gmail: { host: 'imap.gmail.com', help: 'Gmail 需开启 IMAP；通常需使用 Google 应用专用密码。' },
};

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    headers: { 'Content-Type': 'application/json', ...init?.headers },
    ...init,
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) throw new Error(payload?.message || payload?.error || `请求失败（${response.status}）`);
  return payload as T;
}

function emptyMailForm(): MailForm {
  return { imap_host: '', imap_port: 993, user: '', password: '', drafts_folder: '', signature: '' };
}

function mailForm(settings: MailSettings): MailForm {
  return { imap_host: settings.imap_host || '', imap_port: settings.imap_port || 993, user: settings.user || '', password: '', drafts_folder: settings.drafts_folder || '', signature: settings.signature || '' };
}

function Field({ label, value, onChange, type = 'text', placeholder }: { label: string; value: string | number; onChange: (value: string) => void; type?: string; placeholder?: string }) {
  return <label className="field"><span>{label}</span><input type={type} value={value} placeholder={placeholder} onChange={(event) => onChange(event.target.value)} /></label>;
}

export interface NewInquiryDialogProps {
  onClose: () => void;
  onCreate: (payload: { name: string; buyer: string; inquiry: string; channel: Channel }) => void;
  onOpenCase: (caseRecord: CaseRecord) => void;
  busy: boolean;
}

export default function NewInquiryDialog({ onClose, onCreate, onOpenCase, busy }: NewInquiryDialogProps) {
  const [channel, setChannel] = useState<Channel>('email');
  const [manualMode, setManualMode] = useState(false);
  const [name, setName] = useState('');
  const [buyer, setBuyer] = useState('');
  const [inquiry, setInquiry] = useState('');
  const [mailSettings, setMailSettings] = useState<MailSettings | null>(null);
  const [mailStatus, setMailStatus] = useState<MailStatus | null>(null);
  const [mailFormState, setMailFormState] = useState<MailForm>(emptyMailForm);
  const [settingsOpen, setSettingsOpen] = useState(true);
  const [mailLoading, setMailLoading] = useState(true);
  const [mailBusy, setMailBusy] = useState(false);
  const [threads, setThreads] = useState<MailThread[]>([]);
  const [selectedThreadId, setSelectedThreadId] = useState('');
  const [threadPreview, setThreadPreview] = useState<MailThreadPreview | null>(null);
  const [inboxLoading, setInboxLoading] = useState(false);
  const [importBusy, setImportBusy] = useState(false);
  const [captures, setCaptures] = useState<ExtensionCapture[]>([]);
  const [selectedCaptureId, setSelectedCaptureId] = useState('');
  const [capturePreview, setCapturePreview] = useState<ExtensionCapturePreview | null>(null);
  const [captureLoading, setCaptureLoading] = useState(false);
  const [captureBusy, setCaptureBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const dialogRef = useRef<HTMLElement | null>(null);
  const selectedCaptureIdRef = useRef(selectedCaptureId);
  const threadPreviewRequest = useRef(0);
  const capturePreviewRequest = useRef(0);
  selectedCaptureIdRef.current = selectedCaptureId;
  useDialogAccessibility(dialogRef, onClose);

  const loadMailSettings = async () => {
    setMailLoading(true);
    try {
      const response = await api<{ settings: MailSettings; status: MailStatus }>('/api/workflow1/settings/mail');
      setMailSettings(response.settings);
      setMailStatus(response.status);
      setMailFormState(mailForm(response.settings));
      setSettingsOpen(!response.settings.has_password || response.status.mode !== 'imap');
      setNotice(null);
    } catch (error) {
      setMailStatus(null);
      setMailSettings(null);
      setSettingsOpen(true);
      setNotice({ kind: 'error', message: error instanceof Error ? error.message : '邮箱服务不可用，可手动填写询盘' });
    } finally { setMailLoading(false); }
  };

  useEffect(() => { void loadMailSettings(); }, []);

  useEffect(() => {
    if (channel !== 'rfq') return;
    let active = true;
    const refresh = async (quiet = false) => {
      if (!quiet) setCaptureLoading(true);
      try {
        const result = await api<{ captures: ExtensionCapture[] }>('/api/extension/captures');
        if (!active) return;
        setCaptures(result.captures || []);
        const selectedId = selectedCaptureIdRef.current;
        if (selectedId && !result.captures?.some((capture) => capture.id === selectedId)) {
          capturePreviewRequest.current += 1;
          setSelectedCaptureId('');
          setCapturePreview(null);
        }
        if (!quiet) setNotice(null);
      } catch (error) {
        if (active && !quiet) setNotice({ kind: 'error', message: error instanceof Error ? error.message : '捕获列表读取失败' });
      } finally {
        if (active && !quiet) setCaptureLoading(false);
      }
    };
    void refresh();
    const timer = setInterval(() => void refresh(true), 3000);
    return () => { active = false; capturePreviewRequest.current += 1; clearInterval(timer); };
  }, [channel]);

  const patchMailForm = (key: keyof MailForm, value: string | number) => setMailFormState((current) => ({ ...current, [key]: value }));
  const updateProvider = (key: string) => {
    const preset = PRESETS[key];
    if (preset) setMailFormState((current) => ({ ...current, imap_host: preset.host, imap_port: 993 }));
  };
  const refreshInbox = async () => {
    setInboxLoading(true);
    setNotice({ kind: 'info', message: '正在同步收件箱…' });
    try {
      const result = await api<{ threads: MailThread[] }>('/api/workflow1/mail/threads?refresh=true');
      setThreads(result.threads || []);
      setSelectedThreadId('');
      setThreadPreview(null);
      setNotice(null);
    } catch (error) {
      setNotice({ kind: 'error', message: error instanceof Error ? error.message : '收件箱同步失败，请重试' });
    } finally { setInboxLoading(false); }
  };
  const selectThread = async (threadId: string) => {
    const requestId = ++threadPreviewRequest.current;
    setSelectedThreadId(threadId);
    setThreadPreview(null);
    setNotice(null);
    try {
      const preview = await api<MailThreadPreview>(`/api/workflow1/mail/thread/${encodeURIComponent(threadId)}`);
      if (requestId !== threadPreviewRequest.current || preview.thread_id !== threadId) return;
      setThreadPreview(preview);
    } catch (error) {
      if (requestId !== threadPreviewRequest.current) return;
      setNotice({ kind: 'error', message: error instanceof Error ? error.message : '邮件预览失败，请刷新收件箱' });
    }
  };
  const importThread = async () => {
    if (!selectedThreadId || threadPreview?.thread_id !== selectedThreadId) return;
    setImportBusy(true);
    setNotice({ kind: 'info', message: '正在分析并同步邮件询盘…' });
    try {
      const result = await api<Record<string, unknown>>('/api/workflow1/mail/analyze', { method: 'POST', body: JSON.stringify({ thread_id: selectedThreadId }) });
      const sync = await api<{ case: CaseRecord; replay: boolean }>('/api/workflow1/sync', { method: 'POST', body: JSON.stringify(result) });
      onOpenCase(sync.case);
    } catch (error) {
      setNotice({ kind: 'error', message: error instanceof Error ? error.message : '邮件导入失败，所选邮件仍保留，可重试' });
    } finally { setImportBusy(false); }
  };
  const selectCapture = async (captureId: string) => {
    const requestId = ++capturePreviewRequest.current;
    setSelectedCaptureId(captureId);
    setCapturePreview(null);
    setNotice(null);
    try {
      const preview = await api<ExtensionCapturePreview>(`/api/extension/captures/${encodeURIComponent(captureId)}`);
      if (requestId !== capturePreviewRequest.current || preview.id !== captureId) return;
      setCapturePreview(preview);
    } catch (error) {
      if (requestId !== capturePreviewRequest.current) return;
      setNotice({ kind: 'error', message: error instanceof Error ? error.message : '捕获预览失败，请刷新列表' });
    }
  };
  const importCapture = async () => {
    if (!selectedCaptureId || capturePreview?.id !== selectedCaptureId) return;
    setCaptureBusy(true);
    setNotice({ kind: 'info', message: '正在分析并同步插件询盘…' });
    try {
      const result = await api<{ case: CaseRecord; replay: boolean }>(`/api/extension/captures/${encodeURIComponent(selectedCaptureId)}/import`, { method: 'POST', body: '{}' });
      onOpenCase(result.case);
    } catch (error) {
      setNotice({ kind: 'error', message: error instanceof Error ? error.message : '插件询盘导入失败，所选内容仍保留，可重试' });
    } finally { setCaptureBusy(false); }
  };
  const sendMailSettings = async (testOnly: boolean) => {
    setMailBusy(true);
    setNotice({ kind: 'info', message: testOnly ? '正在测试邮箱连接…' : '正在保存邮箱设置…' });
    try {
      const payload = { ...mailFormState, user: mailFormState.user.trim(), password: mailFormState.password.trim(), imap_host: mailFormState.imap_host.trim() };
      if (testOnly) {
        const result = await api<{ imap?: { ok: boolean; message?: string; warning?: string } }>('/api/workflow1/settings/mail/test', { method: 'POST', body: JSON.stringify(payload) });
        setNotice({ kind: result.imap?.ok ? 'success' : 'error', message: result.imap?.warning || result.imap?.message || (result.imap?.ok ? '邮箱连接测试通过' : '邮箱连接测试失败') });
      } else {
        const result = await api<{ settings: MailSettings; status: MailStatus; test?: { imap?: { message?: string; warning?: string } } }>('/api/workflow1/settings/mail', { method: 'POST', body: JSON.stringify(payload) });
        setMailSettings(result.settings);
        setMailStatus(result.status);
        setMailFormState(mailForm(result.settings));
        setSettingsOpen(false);
        setNotice({ kind: 'success', message: result.test?.imap?.warning || '邮箱设置已保存并同步收件箱' });
      }
    } catch (error) {
      setNotice({ kind: 'error', message: error instanceof Error ? error.message : '邮箱设置操作失败' });
    } finally { setMailBusy(false); }
  };

  const portalTarget = document.getElementById('dialog-root') || document.body;
  const selectedPreset = Object.entries(PRESETS).find(([, value]) => value.host === mailFormState.imap_host)?.[0] || '';

  return createPortal(<div className="dialog-backdrop" data-dialog-portal onClick={onClose}>
    <section ref={dialogRef} className="new-case-dialog new-inquiry-dialog" role="dialog" aria-modal="true" aria-labelledby="new-case-dialog-title" tabIndex={-1} onClick={(event) => event.stopPropagation()}>
      <div className="dialog-head">
        <div><h2 id="new-case-dialog-title">新建询盘</h2><p>选择实际入口，预览来源内容后再导入；也可手动录入。</p></div>
        <button className="icon-button" aria-label="关闭新建询盘" title="关闭新建询盘" onClick={onClose} data-dialog-initial-focus><X size={18} /></button>
      </div>
      <div className="new-inquiry-channel" role="group" aria-label="选择询盘入口">
        <button type="button" aria-pressed={channel === 'email'} className={channel === 'email' ? 'active' : ''} onClick={() => { setChannel('email'); setManualMode(false); }}><span>邮箱</span></button>
        <button type="button" aria-pressed={channel === 'rfq'} className={channel === 'rfq' ? 'active' : ''} onClick={() => { setChannel('rfq'); setManualMode(false); }}><span>浏览器插件</span></button>
      </div>
      {channel === 'email' ? <section id="email-intake-panel" className="intake-panel" aria-labelledby="email-intake-title">
        <div className="intake-panel-heading"><div><h3 id="email-intake-title">邮箱收件箱</h3><p>{mailLoading ? '正在检查邮箱连接…' : mailStatus?.mode === 'imap' ? `已连接 · ${mailStatus.address || mailSettings?.user || '邮箱账号'}` : '未连接邮箱，完成 IMAP 设置后同步邮件'}</p></div>
          <div className="intake-heading-actions"><button type="button" className="button button-secondary button-small" onClick={() => setSettingsOpen((value) => !value)}><Settings2 size={14} /> <span>邮箱设置</span></button><button type="button" className="button button-secondary button-small" onClick={() => void refreshInbox()} disabled={mailStatus?.mode !== 'imap' || inboxLoading || mailLoading}><RefreshCw size={14} className={inboxLoading ? 'spin' : ''} /> <span>刷新收件箱</span></button></div>
        </div>
        {settingsOpen && <div className="mail-settings-form">
          <label className="field"><span>邮箱服务商</span><select value={selectedPreset} onChange={(event) => updateProvider(event.target.value)}><option value="">自定义 IMAP</option><option value="qq">QQ 邮箱</option><option value="163">163 邮箱</option><option value="126">126 邮箱</option><option value="exmail">腾讯企业邮</option><option value="aliyun">阿里企业邮</option><option value="gmail">Gmail</option></select></label>
          <p className="mail-provider-help">{PRESETS[selectedPreset]?.help || '填写邮箱服务商提供的 IMAP 地址和端口。密码只用于本机邮箱连接设置。'}</p>
          <div className="mail-settings-grid">
            <Field label="IMAP 服务器" value={mailFormState.imap_host} onChange={(value) => patchMailForm('imap_host', value)} placeholder="imap.example.com" />
            <Field label="端口" value={mailFormState.imap_port} onChange={(value) => patchMailForm('imap_port', Number(value) || 993)} type="number" />
            <Field label="邮箱账号" value={mailFormState.user} onChange={(value) => patchMailForm('user', value)} placeholder="sales@example.com" />
            <Field label="授权码 / 应用密码" value={mailFormState.password} onChange={(value) => patchMailForm('password', value)} type="password" placeholder={mailSettings?.has_password ? '已保存，留空表示不修改' : '邮箱生成的授权码'} />
            <Field label="草稿箱名称（可选）" value={mailFormState.drafts_folder} onChange={(value) => patchMailForm('drafts_folder', value)} placeholder="自动识别" />
            <Field label="邮件落款（可选）" value={mailFormState.signature} onChange={(value) => patchMailForm('signature', value)} placeholder="公司名称 / 联系方式" />
          </div>
          <div className="intake-actions"><button type="button" className="button button-secondary button-small" onClick={() => void sendMailSettings(true)} disabled={mailBusy || mailLoading}><RefreshCw size={14} /> <span>测试连接</span></button><button type="button" className="button button-primary button-small" onClick={() => void sendMailSettings(false)} disabled={mailBusy || mailLoading}><span>{mailBusy ? '处理中…' : '保存邮箱设置'}</span></button></div>
        </div>}
        {mailStatus?.mode === 'imap' && !settingsOpen ? <div className="mail-thread-content">
          {threads.length === 0 ? <div className="inbox-empty-state"><RefreshCw size={16} /><span>{inboxLoading ? '正在读取收件箱…' : '收件箱为空，点击“刷新收件箱”同步邮件。'}</span></div> : <div className="mail-thread-list" aria-label="邮件会话">
            {threads.map((thread) => <button type="button" key={thread.thread_id} className={`mail-thread-row ${selectedThreadId === thread.thread_id ? 'selected' : ''}`} aria-pressed={selectedThreadId === thread.thread_id} onClick={() => void selectThread(thread.thread_id)}>
              <span className="mail-thread-title">{thread.subject || '无主题'}</span><span className="mail-thread-meta">{thread.buyer_name || thread.buyer_addr} · {new Date(thread.updated_at).toLocaleString('zh-CN')}</span><span className="mail-thread-preview">{thread.preview}</span>
            </button>)}
          </div>}
          {threadPreview && <section id="email-thread-preview" className="email-thread-preview" aria-label="邮件正文预览"><div><strong>{threadPreview.subject || '无主题'}</strong><span>{threadPreview.messages.length} 封邮件 · 选取最新买家来信分析</span></div>{threadPreview.messages.map((message) => <article key={message.message_id}><header><strong>{message.from_name || message.from_email}</strong><time>{new Date(message.date).toLocaleString('zh-CN')}</time></header><p>{message.body_clean}</p></article>)}<button type="button" className="button button-primary button-small" disabled={importBusy} onClick={() => void importThread()}>{importBusy ? <Loader2 size={14} className="spin" /> : <Plus size={14} />} <span>{importBusy ? '正在导入…' : '导入到案件'}</span></button></section>}
        </div> : <div className="inbox-empty-state"><RefreshCw size={16} /><span>连接邮箱后可同步并选择一封询盘邮件。</span></div>}
        <button type="button" className="text-button" onClick={() => setManualMode(true)}>手动填写邮箱询盘</button>
      </section> : <section id="extension-intake-panel" className="intake-panel" aria-labelledby="extension-intake-title">
        <div className="intake-panel-heading"><div><h3 id="extension-intake-title">浏览器插件</h3><p>在阿里巴巴国际站对话中复核原文并提交，再从待选列表导入。</p></div><button type="button" className="button button-secondary button-small" onClick={() => void (async () => { setCaptureLoading(true); try { const result = await api<{ captures: ExtensionCapture[] }>('/api/extension/captures'); setCaptures(result.captures || []); setNotice(null); } catch (error) { setNotice({ kind: 'error', message: error instanceof Error ? error.message : '捕获列表读取失败' }); } finally { setCaptureLoading(false); } })()} disabled={captureLoading}><RefreshCw size={14} className={captureLoading ? 'spin' : ''} /><span>刷新待选</span></button></div>
        {captures.length === 0 ? <div className="inbox-empty-state"><span>{captureLoading ? '正在检查本机待选列表…' : '暂无待选询盘。请在插件中复核消息并提交到新建询盘。'}</span></div> : <div className="mail-thread-content">
          <div className="mail-thread-list" aria-label="插件捕获的询盘">
            {captures.map((capture) => <button type="button" key={capture.id} className={`mail-thread-row ${selectedCaptureId === capture.id ? 'selected' : ''}`} aria-pressed={selectedCaptureId === capture.id} onClick={() => void selectCapture(capture.id)}>
              <span className="mail-thread-title">{capture.sourceUrl}</span><span className="mail-thread-meta">提交于 {new Date(capture.createdAt).toLocaleString('zh-CN')} · {capture.id}</span>
            </button>)}
          </div>
          {capturePreview && <section id="extension-capture-preview" className="email-thread-preview" aria-label="插件询盘预览"><div><strong>询盘原文</strong><span>{capturePreview.sourceUrl}</span><time>{new Date(capturePreview.createdAt).toLocaleString('zh-CN')}</time></div><article><p>{capturePreview.text}</p></article><button type="button" className="button button-primary button-small" disabled={captureBusy} onClick={() => void importCapture()}>{captureBusy ? <Loader2 size={14} className="spin" /> : <Plus size={14} />} <span>{captureBusy ? '正在导入…' : '预览并导入到案件'}</span></button></section>}
        </div>}
        <button type="button" className="text-button" onClick={() => setManualMode(true)}>手动填写 RFQ 询盘</button>
      </section>}
      {manualMode && <form className="manual-inquiry-form" onSubmit={(event: FormEvent) => { event.preventDefault(); onCreate({ name, buyer, inquiry, channel }); }}>
        <div className="intake-panel-heading"><div><h3>手动录入</h3><p>原文会保存到案件记录中，渠道保持为 {channel === 'email' ? '邮箱' : 'RFQ'}。</p></div><button type="button" className="text-button" onClick={() => setManualMode(false)}>返回渠道导入</button></div>
        <Field label="案件名称" value={name} onChange={setName} placeholder="例如：NL-L 德国买家询盘" />
        <Field label="买家 / 公司" value={buyer} onChange={setBuyer} placeholder="例如：Nordlicht GmbH" />
        <label className="field"><span>客户原话 / 询盘（中文、英语或德语）</span><textarea value={inquiry} onChange={(event) => setInquiry(event.target.value)} rows={4} placeholder="例如：请把额定功率改为 36W，并提升到 IP44…" /></label>
        <div className="dialog-actions"><button type="button" className="button button-secondary" onClick={onClose}>取消</button><button type="submit" className="button button-primary" disabled={busy || !name.trim() || !buyer.trim() || !inquiry.trim()}>{busy ? <Loader2 size={15} className="spin" /> : <Plus size={15} />} 创建并进入询盘</button></div>
      </form>}
      {notice && <p className={`intake-notice notice-${notice.kind}`} role="status">{notice.message}</p>}
    </section>
  </div>, portalTarget);
}

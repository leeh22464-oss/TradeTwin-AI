import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  BookOpen, Check, ChevronDown, ExternalLink, FileCheck2, FolderOpen, Globe2, Loader2,
  Plus, RefreshCw, Search, ShieldAlert, Tag,
} from 'lucide-react';
import type {
  KnowledgeEntry, KnowledgeIndex, KnowledgeSource, ResearchCitation, ResearchResult,
  RuntimeKnowledgeStatus,
} from '../../shared/types';

type Notice = { kind: 'success' | 'error' | 'info'; message: string };
type KnowledgeKind = 'all' | 'public_source' | 'checklist' | 'glossary' | 'guidance' | 'local';

interface KnowledgeWorkspaceProps {
  entries: KnowledgeEntry[];
  runtimeKnowledge?: RuntimeKnowledgeStatus;
  onRefresh: () => void | Promise<void>;
  onNotice: (notice: Notice) => void;
}

const KIND_LABELS: Record<KnowledgeKind, string> = {
  all: '全部类型',
  public_source: '公开来源',
  checklist: '检查清单',
  glossary: '术语',
  guidance: '规则卡 / 指引',
  local: '项目内知识',
};

const RESEARCH_MODE_LABELS: Record<ResearchResult['mode'], string> = {
  local: '仅本地索引·未联网',
  live: '已联网核查',
  fallback: '联网未完成·本地回退',
};

function researchModeLabel(result: ResearchResult) {
  if (result.mode === 'fallback' && result.webSearchPerformed) return '搜索完成·回答未采用';
  return RESEARCH_MODE_LABELS[result.mode];
}

async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    headers: {
      ...(init?.body instanceof FormData ? {} : { 'Content-Type': 'application/json' }),
      ...init?.headers,
    },
    ...init,
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(payload?.error || payload?.message || `请求失败（${response.status}）`);
  }
  return payload as T;
}

function formatDate(value: string | null | undefined, fallback = '未提供') {
  if (!value) return fallback;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' });
}

function formatDateTime(value: string | null | undefined, fallback = '未联网') {
  if (!value) return fallback;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString('zh-CN', {
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  });
}

function safeHttpsUrl(value: string | undefined | null): string | null {
  if (!value) return null;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' ? parsed.href : null;
  } catch {
    return null;
  }
}

function kindOf(entry: KnowledgeEntry): Exclude<KnowledgeKind, 'all'> {
  return entry.metadata?.kind || 'local';
}

function kindLabel(entry: KnowledgeEntry) {
  return KIND_LABELS[kindOf(entry)];
}

function LocalEntryFlag({ entry }: { entry: KnowledgeEntry }) {
  if (entry.metadata) return null;
  if (entry.source === 'manual') return <span className="knowledge-flag local"><Tag size={11} />人工添加</span>;
  if (entry.source === 'obsidian-vault') return <span className="knowledge-flag local"><FolderOpen size={11} />只读导入</span>;
  return <span className="knowledge-flag local"><BookOpen size={11} />项目内知识</span>;
}

function sourceForEntry(entry: KnowledgeEntry, sources: KnowledgeSource[]) {
  const sourceId = entry.metadata?.sourceId;
  return sourceId ? sources.find((source) => source.sourceId === sourceId) : undefined;
}

function EntryProvenance({ entry, sources, localIndex = false }: { entry: KnowledgeEntry; sources: KnowledgeSource[]; localIndex?: boolean }) {
  const source = sourceForEntry(entry, sources);
  const sourceUrl = entry.metadata?.sourceUrl || source?.url;
  const safeUrl = safeHttpsUrl(sourceUrl);
  const sourceLabel = source?.title || entry.source || '项目内知识';
  return <dl className="knowledge-entry-provenance">
    <div><dt>来源</dt><dd>{sourceLabel}</dd></div>
    {entry.metadata?.publisher && <div><dt>发布方</dt><dd>{entry.metadata.publisher}</dd></div>}
    <div><dt>{entry.metadata ? '索引日期' : '更新时间'}</dt><dd>{formatDate(entry.metadata?.asOf || entry.updatedAt)}</dd></div>
    {entry.metadata?.packageVersion && <div><dt>包版本</dt><dd>{entry.metadata.packageVersion}</dd></div>}
    {sourceUrl && <div className="knowledge-entry-url"><dt>来源 URL</dt><dd>{safeUrl ? <a href={safeUrl} target="_blank" rel="noreferrer">{localIndex ? '打开索引记录中的来源（非本次联网证据）' : safeUrl}<ExternalLink size={12} /></a> : <span>已过滤非 HTTPS 地址</span>}</dd></div>}
  </dl>;
}

function KnowledgeEntryRow({ entry, sources }: { entry: KnowledgeEntry; sources: KnowledgeSource[] }) {
  const source = sourceForEntry(entry, sources);
  return <details className="knowledge-entry-row">
    <summary>
      <span className="knowledge-kind">{kindLabel(entry)}</span>
      <span className="knowledge-entry-title" title={entry.title}>{entry.title}</span>
      <span className="knowledge-entry-source">{source?.identifier || entry.source || '项目内知识'}</span>
      <span className="knowledge-entry-date">{formatDate(entry.metadata?.asOf || entry.updatedAt)}</span>
      <ChevronDown size={15} aria-hidden="true" />
    </summary>
    <div className="knowledge-entry-detail">
      <div className="knowledge-entry-copy"><p>{entry.content}</p></div>
      <div className="knowledge-entry-flags">
        {entry.metadata?.humanReviewRequired && <span className="knowledge-flag review"><ShieldAlert size={12} />人工确认</span>}
        {entry.metadata?.synthetic && <span className="knowledge-flag synthetic">合成示意</span>}
        <LocalEntryFlag entry={entry} />
        {entry.tags.map((tag) => <span className="knowledge-flag tag" key={tag}><Tag size={11} />{tag}</span>)}
      </div>
      <EntryProvenance entry={entry} sources={sources} />
    </div>
  </details>;
}

function InlineResearchAnswer({ answer, citations }: { answer: string; citations: ResearchCitation[] }) {
  const usable: Array<{ citation: ResearchCitation; index: number; href: string; start: number; end: number }> = [];
  let cursor = 0;
  citations.forEach((citation, index) => {
    const href = safeHttpsUrl(citation.url);
    const start = Number(citation.startIndex);
    const end = Number(citation.endIndex);
    const validRange = Number.isInteger(start) && Number.isInteger(end)
      && start >= 0 && end > start && end <= answer.length;
    if (!validRange || start < cursor) return;
    cursor = end;
    if (!href) return;
    usable.push({ citation, index, href, start, end });
  });

  if (!usable.length) return <p className="research-answer-text">{answer}</p>;

  const nodes: ReactNode[] = [];
  let offset = 0;
  usable.forEach(({ citation, index, href, start, end }) => {
    if (start > offset) nodes.push(answer.slice(offset, start));
    nodes.push(<a className="research-citation-inline" key={`inline-${index}`} href={href} target="_blank" rel="noreferrer" title={citation.title || '打开引用来源'}>{answer.slice(start, end)}<sup>[{index + 1}]</sup></a>);
    offset = end;
  });
  if (offset < answer.length) nodes.push(answer.slice(offset));
  return <p className="research-answer-text">{nodes}</p>;
}

function ResearchCitationList({ citations, answerLength }: { citations: ResearchCitation[]; answerLength: number }) {
  const inlineIndices = useMemo(() => {
    const accepted = new Set<number>();
    let cursor = 0;
    citations.forEach((citation, index) => {
      const href = safeHttpsUrl(citation.url);
      const start = Number(citation.startIndex);
      const end = Number(citation.endIndex);
      if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start || end > answerLength || start < cursor) return;
      cursor = end;
      if (!href) return;
      accepted.add(index);
    });
    return accepted;
  }, [answerLength, citations]);

  if (!citations.length) return <p className="research-muted">本次回答没有返回联网引用。</p>;
  return <ol className="research-citation-list">
    {citations.map((citation, index) => {
      const href = safeHttpsUrl(citation.url);
      const title = citation.title || citation.url;
      return <li key={`${citation.url}-${index}`}>
        <span className="research-citation-number">[{index + 1}]</span>
        {href ? <a href={href} target="_blank" rel="noreferrer">{title}<ExternalLink size={12} /></a> : <span className="research-unsafe-url">{title}（已过滤非 HTTPS 地址）</span>}
        {citation.sourceId && <small>{citation.sourceId}</small>}
        {!citation.sourceId && href && inlineIndices.has(index) && <small>同域补充来源 · 需核对与所选法规的关联</small>}
        {!inlineIndices.has(index) && <em>范围无效或与其他引用重叠，已降为来源列表</em>}
      </li>;
    })}
  </ol>;
}

function ResearchLocalEntries({ entries, sources }: { entries: KnowledgeEntry[]; sources: KnowledgeSource[] }) {
  if (!entries.length) return null;
  return <section className="research-local-index">
    <div className="research-section-head"><div><h3>本地索引命中</h3><p>这是项目内结构化线索，不是本次联网搜索证据；合成条目仍会明确标识。</p></div><span>{entries.length} 条</span></div>
    <div className="research-local-list">
      {entries.map((entry) => <details className="research-local-entry" key={entry.id}>
        <summary><BookOpen size={14} /><strong>{entry.title}</strong><span>{kindLabel(entry)}</span><ChevronDown size={14} /></summary>
        <div className="research-local-detail"><p>{entry.content}</p><div className="knowledge-entry-flags"><LocalEntryFlag entry={entry} />{entry.metadata?.synthetic && <span className="knowledge-flag synthetic">合成示意</span>}{entry.metadata?.humanReviewRequired && <span className="knowledge-flag review"><ShieldAlert size={12} />人工确认</span>}</div><EntryProvenance entry={entry} sources={sources} localIndex /></div>
      </details>)}
    </div>
  </section>;
}

function ResearchResultView({ result, sources, indexedOn }: { result: ResearchResult; sources: KnowledgeSource[]; indexedOn?: string }) {
  const isLive = result.mode === 'live';
  const searchCompleted = result.webSearchPerformed === true;
  const consulted = isLive ? result.consultedSources || [] : [];
  const answerSourceLabel = isLive ? result.modelName || '官方模型' : result.mode === 'fallback' && searchCompleted && result.modelName ? `本地回退 · ${result.modelName}` : result.mode === 'fallback' ? '本地回退' : '本地索引检索';
  return <section className="research-result" aria-live="polite">
    <div className="research-result-head"><div><span className={`research-mode research-mode-${result.mode}`}>{researchModeLabel(result)}</span><h3>核查结果</h3></div><dl><div><dt>索引日期</dt><dd>{formatDate(indexedOn, '以索引包为准')}</dd></div><div><dt>本次核查时间</dt><dd>{searchCompleted ? formatDateTime(result.checkedAt, '时间未返回') : '未联网'}</dd></div><div><dt>网页搜索</dt><dd>{searchCompleted ? '已执行' : '未执行'}</dd></div></dl></div>
    <div className="research-result-query"><span>本次提交问题</span><p>{result.query}</p></div>
    {result.warnings.length > 0 && <div className="research-warning"><ShieldAlert size={15} /><span>{result.warnings.join('；')}</span></div>}
    <div className="research-answer"><div className="research-section-head"><div><h4>回答</h4><p>{answerSourceLabel}</p></div></div><InlineResearchAnswer answer={result.answer} citations={isLive ? result.citations : []} /></div>
    <div className="research-sources"><div className="research-section-head"><div><h4>{isLive ? '联网引用' : searchCompleted ? '搜索未采用' : '本次未联网'}</h4><p>{isLive ? '只有 HTTPS 引用会成为可点击外链；本地索引来源单独列在下方。' : searchCompleted ? '本次回答未通过核验，当前显示本地线索；具体原因见上方警告。' : '当前结果只来自本地索引或回退模板，不把索引 URL 当作本次联网证据。'}</p></div><span>{isLive ? consulted.length || result.citations.length : '—'}</span></div>{isLive ? <><ResearchCitationList citations={result.citations} answerLength={result.answer.length} />{consulted.length > 0 && <ul className="research-consulted-list">{consulted.map((source, index) => { const href = safeHttpsUrl(source.url); return <li key={`${source.url}-${index}`}>{href ? <a href={href} target="_blank" rel="noreferrer">{source.title || source.url}<ExternalLink size={12} /></a> : <span>{source.title || source.url}（已过滤非 HTTPS 地址）</span>}</li>; })}</ul>}</> : <p className="research-muted">{searchCompleted ? '本次回答未通过核验，当前显示本地线索；请展开下方“本地索引命中”查看来源引用。' : '请展开下方“本地索引命中”查看来源引用。'}</p>}</div>
    <ResearchLocalEntries entries={result.localEntries} sources={result.indexedSources.length ? result.indexedSources : sources} />
  </section>;
}

function RuntimeKnowledgePanel({ runtimeKnowledge }: { runtimeKnowledge?: RuntimeKnowledgeStatus }) {
  if (!runtimeKnowledge) return null;
  const statusLabel = runtimeKnowledge.available ? '已载入' : '需确认';
  return <details className="knowledge-runtime-panel">
    <summary className="knowledge-section-head knowledge-runtime-summary"><div><h2>推演数据来源</h2><p>核对版本、指纹与来源文件。</p></div><span className={`knowledge-runtime-status ${runtimeKnowledge.available ? 'is-available' : 'is-review'}`}>{statusLabel} · {runtimeKnowledge.sources.length} 个来源 <ChevronDown size={15} aria-hidden="true" /></span></summary>
    <div className="knowledge-runtime-body">
      <dl className="knowledge-runtime-meta"><div><dt>Profile</dt><dd>{runtimeKnowledge.profileId}</dd></div><div><dt>版本</dt><dd>{runtimeKnowledge.version}</dd></div><div><dt>来源指纹</dt><dd title={runtimeKnowledge.fingerprint}>{runtimeKnowledge.fingerprint.slice(0, 16)}…</dd></div></dl>
      <p className="knowledge-runtime-note">EMC 不自动放行；新驱动增加 3 天打样，最终排期待确认。</p>
      {runtimeKnowledge.warnings.length > 0 && <div className="knowledge-warning"><ShieldAlert size={15} /><span>{runtimeKnowledge.warnings.join('；')}</span></div>}
      <ul className="knowledge-runtime-sources">{runtimeKnowledge.sources.map((source, index) => <li key={`${source.path}-${index}`}><div><strong>{source.path}</strong><span>{[source.documentId && `文档 ${source.documentId}`, source.ruleId && `规则 ${source.ruleId}`, source.page !== undefined && `第 ${source.page} 页`, source.sha256 && `指纹 ${source.sha256.slice(0, 12)}…`].filter(Boolean).join(' · ') || '未提供细分定位'}</span></div><a href={`/api/runtime/sources/${index}`} target="_blank" rel="noreferrer">打开来源记录 <ExternalLink size={12} /></a></li>)}</ul>
    </div>
  </details>;
}

export default function KnowledgeWorkspace({ entries, runtimeKnowledge, onRefresh, onNotice }: KnowledgeWorkspaceProps) {
  const [index, setIndex] = useState<KnowledgeIndex | null>(null);
  const [indexLoading, setIndexLoading] = useState(true);
  const [indexError, setIndexError] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [query, setQuery] = useState('');
  const [kind, setKind] = useState<KnowledgeKind>('all');
  const [showAdd, setShowAdd] = useState(false);
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [saving, setSaving] = useState(false);
  const [researchQuery, setResearchQuery] = useState('');
  const [selectedSourceIds, setSelectedSourceIds] = useState<string[]>([]);
  const [sourceListOpen, setSourceListOpen] = useState(false);
  const [researchBusy, setResearchBusy] = useState(false);
  const [researchError, setResearchError] = useState<string | null>(null);
  const [researchResult, setResearchResult] = useState<ResearchResult | null>(null);

  const loadIndex = useCallback(async () => {
    setIndexLoading(true);
    try {
      const next = await requestJson<KnowledgeIndex>('/api/knowledge/index');
      setIndex(next);
      setIndexError(null);
      setSelectedSourceIds((current) => {
        const ids = next.sources.map((source) => source.sourceId);
        if (!current.length) return ids;
        return current.filter((sourceId) => ids.includes(sourceId));
      });
    } catch (error) {
      setIndexError(error instanceof Error ? error.message : '知识索引读取失败');
    } finally {
      setIndexLoading(false);
    }
  }, []);

  useEffect(() => { void loadIndex(); }, [loadIndex]);

  const filteredEntries = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return entries.filter((entry) => {
      const matchesKind = kind === 'all' || kindOf(entry) === kind;
      if (!matchesKind) return false;
      if (!needle) return true;
      const haystack = [entry.title, entry.content, entry.source, entry.metadata?.publisher, entry.metadata?.sourceId, entry.metadata?.sourceUrl, ...entry.tags].filter(Boolean).join(' ').toLocaleLowerCase();
      return haystack.includes(needle);
    });
  }, [entries, kind, query]);

  const syncIndex = async () => {
    if (syncing || researchBusy) return;
    setSyncing(true);
    try {
      await requestJson('/api/knowledge/sync', { method: 'POST' });
      await onRefresh();
      await loadIndex();
      onNotice({ kind: 'success', message: '知识索引已同步，列表已刷新' });
    } catch (error) {
      onNotice({ kind: 'error', message: error instanceof Error ? error.message : '知识索引同步失败' });
    } finally {
      setSyncing(false);
    }
  };

  const add = async () => {
    if (!title.trim() || !content.trim()) return;
    setSaving(true);
    try {
      await requestJson('/api/knowledge', { method: 'POST', body: JSON.stringify({ title: title.trim(), content: content.trim(), tags: ['manual'] }) });
      setTitle('');
      setContent('');
      setShowAdd(false);
      await onRefresh();
      onNotice({ kind: 'success', message: '知识条目已保存' });
    } catch (error) {
      onNotice({ kind: 'error', message: error instanceof Error ? error.message : '保存知识失败' });
    } finally {
      setSaving(false);
    }
  };

  const importVault = async () => {
    setSyncing(true);
    try {
      await requestJson('/api/knowledge/import-vault', { method: 'POST' });
      await onRefresh();
      onNotice({ kind: 'success', message: 'Obsidian 知识已导入' });
    } catch (error) {
      onNotice({ kind: 'error', message: error instanceof Error ? error.message : '未配置可导入的 vault' });
    } finally {
      setSyncing(false);
    }
  };

  const research = async () => {
    const trimmed = researchQuery.trim();
    if (!trimmed || !selectedSourceIds.length || researchBusy) return;
    setResearchBusy(true);
    setResearchError(null);
    try {
      const result = await requestJson<ResearchResult>('/api/knowledge/research', { method: 'POST', body: JSON.stringify({ query: trimmed.slice(0, 2000), sourceIds: selectedSourceIds }) });
      setResearchResult(result);
      onNotice({ kind: result.mode === 'live' ? 'success' : 'info', message: result.mode === 'live' ? '联网核查完成' : result.webSearchPerformed ? '本次回答未通过核验，当前显示本地线索' : '已返回本地索引线索，未联网' });
    } catch (error) {
      setResearchError(error instanceof Error ? error.message : '核查请求失败');
    } finally {
      setResearchBusy(false);
    }
  };

  const sources = index?.sources ?? [];
  const configured = index?.research.configured === true;
  const researchEnabled = configured && index?.research.enabled !== false;
  const researchButtonLabel = researchEnabled ? '联网核查' : '查看索引线索';
  const allSelected = sources.length > 0 && selectedSourceIds.length === sources.length;

  return <div className="secondary-page knowledge-workspace">
    <section className="page-heading knowledge-heading">
      <div><h1>知识与规则</h1><p>公开来源与本地索引；结论仍需证据核验。</p></div>
      <div className="knowledge-heading-actions"><button className="button button-secondary" onClick={syncIndex} disabled={syncing || indexLoading || researchBusy}>{syncing ? <Loader2 size={15} className="spin" /> : <RefreshCw size={15} />} 同步索引</button><button className="button button-primary" onClick={() => setShowAdd((value) => !value)}><Plus size={16} /> 添加知识</button></div>
    </section>

    {indexLoading && <div className="knowledge-inline-state"><Loader2 size={16} className="spin" /> 正在读取知识索引…</div>}
    {indexError && <div className="knowledge-error" role="alert"><ShieldAlert size={16} /><span>{indexError}</span><button className="button button-secondary button-small" onClick={() => void loadIndex()}>重试</button></div>}
    {index && <>
      <section className="knowledge-index-strip">
        <div className="knowledge-index-summary"><div><span>索引包</span><strong>{index.package.packageName}</strong><small>{index.package.available ? `包版本 ${index.package.packageVersion} · 索引版本 ${index.package.indexVersion}` : '索引包不可用'}</small></div><div className="knowledge-index-date"><span>索引日期</span><strong>{formatDate(index.package.retrievedOn)}</strong><small>只表示本地索引资料日期</small></div></div>
        <dl className="knowledge-counts"><div><dt>来源入口</dt><dd>{index.package.sourceCount}</dd></div><div><dt>规则卡</dt><dd>{index.package.ruleCardCount}</dd></div><div><dt>检查清单</dt><dd>{index.package.checklistCount}</dd></div><div><dt>术语</dt><dd>{index.package.glossaryCount}</dd></div><div><dt>已导入条目</dt><dd>{index.package.importedCount}</dd></div></dl>
      </section>
      {index.package.warnings.length > 0 && <div className="knowledge-warning"><ShieldAlert size={15} /><span>{index.package.warnings.join('；')}</span></div>}
      <div className="knowledge-boundary"><FileCheck2 size={16} /><span>索引不等于法规全文；缺文件、未知参数和待确认范围均不会自动放行。</span></div>
      {runtimeKnowledge && <RuntimeKnowledgePanel runtimeKnowledge={runtimeKnowledge} />}
    </>}

    <section className="research-panel"><div className="research-panel-head"><div><h2>按索引核查</h2><p>先用本地结构化索引定位线索；配置服务端密钥后才会显示真实联网核查。</p></div><span className={`research-config ${researchEnabled ? 'is-configured' : ''}`}><span className="status-dot" />{researchEnabled ? `已配置 · ${index?.research.model || '官方模型'}` : configured ? '联网核查未启用' : '未配置 OPENAI_API_KEY'}</span></div><div className="research-config-note"><ShieldAlert size={14} /><span>{index?.research.message || '未配置时只返回本地索引线索，不会在浏览器请求密钥。请在项目 .env 填 OPENAI_API_KEY。'}</span></div><label className="research-query"><span>问题</span><textarea value={researchQuery} maxLength={2000} disabled={researchBusy} onChange={(event) => setResearchQuery(event.target.value)} placeholder="例如：30W / IP44 的防护补测能否沿用原 IP20 报告？" rows={3} /><small>{researchQuery.length} / 2000</small></label><details className="research-source-picker" open={sourceListOpen} onToggle={(event) => setSourceListOpen((event.currentTarget as HTMLDetailsElement).open)}><summary><span><Globe2 size={15} />核查范围 · 已选 {selectedSourceIds.length} / {sources.length} 个官方入口</span><ChevronDown size={15} /></summary><div className="research-source-picker-body"><div className="research-source-actions"><span>联网搜索会受限于选中的官方域名范围，不代表已读取法规全文。</span><div><button type="button" onClick={() => setSelectedSourceIds(sources.map((source) => source.sourceId))} disabled={researchBusy || allSelected}>全选</button><button type="button" onClick={() => setSelectedSourceIds([])} disabled={researchBusy || !selectedSourceIds.length}>清空</button></div></div>{sources.map((source) => <label className="research-source-option" key={source.sourceId}><input type="checkbox" disabled={researchBusy} checked={selectedSourceIds.includes(source.sourceId)} onChange={(event) => setSelectedSourceIds((current) => event.target.checked ? [...current, source.sourceId] : current.filter((sourceId) => sourceId !== source.sourceId))} /><span><strong>{source.identifier} · {source.title}</strong><small>{source.publisher} · {source.topic}</small></span></label>)}</div></details><div className="research-submit-row"><button className="button button-primary" onClick={() => void research()} disabled={researchBusy || !researchQuery.trim() || !selectedSourceIds.length || !sources.length}>{researchBusy ? <Loader2 size={15} className="spin" /> : <Search size={15} />}{researchBusy ? '正在核查…' : researchButtonLabel}</button>{!selectedSourceIds.length && <span className="research-validation">至少选择 1 个来源</span>}{!researchQuery.trim() && <span className="research-validation">请输入问题后提交</span>}</div>{researchError && <div className="research-error" role="alert"><ShieldAlert size={15} /><span>{researchError}</span><button className="button button-secondary button-small" onClick={() => void research()} disabled={researchBusy}>重试</button></div>}</section>

    {researchResult && <ResearchResultView result={researchResult} sources={sources} indexedOn={index?.package.retrievedOn} />}

    {showAdd && <section className="add-knowledge knowledge-add-panel"><label className="field"><span>标题</span><input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="例如：德国灯具标签注意事项" /></label><label className="field"><span>正文</span><textarea value={content} onChange={(event) => setContent(event.target.value)} rows={4} placeholder="输入公开或已授权的知识…" /></label><div className="add-actions"><button className="button button-secondary" onClick={() => setShowAdd(false)}>取消</button><button className="button button-primary" onClick={() => void add()} disabled={saving || !title.trim() || !content.trim()}>{saving ? <Loader2 size={15} className="spin" /> : <Check size={15} />} 保存条目</button></div></section>}

    <details className="knowledge-sources-panel knowledge-sources-details"><summary className="knowledge-section-head knowledge-sources-summary"><div><h2>公开来源入口</h2><p>{sources.length ? `${sources.length} 个官方入口用于索引与联网范围` : '当前索引未提供官方入口'}；入口本身不等同于已核验的法规全文。</p></div><span>{sources.length} 个来源 <ChevronDown size={15} aria-hidden="true" /></span></summary><div className="knowledge-source-list">{sources.map((source) => { const href = safeHttpsUrl(source.url); return <article className="knowledge-source-row" key={source.sourceId}><div className="knowledge-source-main"><span className="knowledge-source-id">{source.identifier}</span><strong>{source.title}</strong><small>{source.publisher} · {source.topic}</small><p>{source.scopeNote}</p></div><div className="knowledge-source-meta"><span>索引日期 {formatDate(source.asOf)}</span>{href ? <a href={href} target="_blank" rel="noreferrer">打开官方入口 <ExternalLink size={12} /></a> : <span>非 HTTPS 地址已过滤</span>}</div></article>; })}{sources.length === 0 && !indexLoading && <div className="knowledge-empty"><Globe2 size={20} /><span>暂无来源入口，请先同步索引。</span></div>}</div></details>

    <section className="knowledge-index-panel"><div className="knowledge-section-head"><div><h2>已导入索引条目</h2><p>按条目查看完整正文、来源 URL、索引日期和包版本；支持中文、英文与德文检索。</p></div><span>{filteredEntries.length} / {entries.length} 条</span></div><div className="knowledge-toolbar"><label className="search-field"><span className="knowledge-search-sr-only">搜索知识索引</span><Search size={16} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索中文、English、Deutsch、规则或来源" /></label><label className="knowledge-kind-select"><span>类型</span><select value={kind} onChange={(event) => setKind(event.target.value as KnowledgeKind)}>{Object.entries(KIND_LABELS).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select><ChevronDown size={14} /></label></div><div className="knowledge-entry-list">{filteredEntries.map((entry) => <KnowledgeEntryRow entry={entry} sources={sources} key={entry.id} />)}{filteredEntries.length === 0 && <div className="knowledge-empty"><BookOpen size={20} /><span>{entries.length ? '没有符合当前搜索或类型的条目。' : '暂无索引条目，请先同步知识包。'}</span></div>}</div></section>

    <section className="vault-note knowledge-vault-note"><FolderOpen size={17} /><div><strong>Obsidian 只读导入</strong><span>只有配置 OBSIDIAN_VAULT_PATH 后才会扫描 Markdown，不默认读取你的电脑。</span></div><button className="button button-secondary button-small" onClick={() => void importVault()} disabled={syncing || researchBusy}>{syncing ? <Loader2 size={14} className="spin" /> : <RefreshCw size={14} />} 尝试导入</button></section>
  </div>;
}

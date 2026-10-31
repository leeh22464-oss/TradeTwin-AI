import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  readFileSync,
  realpathSync,
} from 'node:fs';
import {
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'node:path';
import type {
  KnowledgeEntry,
  KnowledgeMetadata,
  KnowledgePackageStatus,
  KnowledgeSource,
} from '../shared/types.js';
import type { AppDatabase } from './db.js';

/**
 * The package is deliberately loaded from a fixed allow-list.  In particular,
 * README/handoff text and the synthetic evidence packs are not part of the
 * default model context.
 */
const KNOWN_FILES = {
  manifest: 'manifest.json',
  sources: 'public-rules/source-index.json',
  rules: 'public-rules/rule-cards.jsonl',
  checklist: 'public-rules/checklist.json',
  glossary: 'glossary/zh-en-de-terms.json',
} as const;

export const MAX_KNOWLEDGE_FILE_BYTES = 512 * 1024;
export const MAX_KNOWLEDGE_TOTAL_BYTES = 4 * 1024 * 1024;

const DEFAULT_PACKAGE_NAME = 'TradeTwin AI Knowledge Base';
const DEFAULT_SCOPE = 'indoor_fixed_led_luminaire';
const DEFAULT_MARKET = 'EU';
const DEFAULT_PACKAGE_VERSION = 'unknown';
const DEFAULT_INDEX_VERSION = 'unknown';
const DEFAULT_RETRIEVED_ON = '';

type JsonRecord = Record<string, unknown>;

export interface KnowledgePackageBundle {
  status: KnowledgePackageStatus;
  sources: KnowledgeSource[];
  entries: KnowledgeEntry[];
}

export interface KnowledgeSearchOptions {
  /** Include internal/synthetic guidance when a UI explicitly requests it. */
  includeSynthetic?: boolean;
}

interface PackageContext {
  packageDir: string;
  packageVersion: string;
  packageName: string;
  market: string;
  productScope: string;
  ruleVerificationDate: string;
}

interface SourceRecord {
  sourceId: string;
  title: string;
  url: string;
  identifier: string;
  publisher: string;
  officialDateOrVersion: string;
  retrievedOn: string;
  topic: string;
  productScopeNote: string;
  humanReviewRequired: true;
}

interface RuleRecord {
  ruleId: string;
  title: string;
  sourceId: string | null;
  articleOrSection: string;
  market: string;
  productScope: string;
  trigger: string;
  checkItem: string;
  evidenceExpected: string[];
  severityDefault: string;
  decisionLimit: string;
  lastVerified: string;
  ruleKind: string;
}

interface ChecklistRecord {
  checkId: string;
  ruleId: string;
  name: string;
  kind: string;
  requiredDocuments: string[];
  fields: string[];
  evidenceExpected: string;
  defaultSeverity: string;
  ownerRole: string;
  decisionLimit: string;
}

interface GlossaryRecord {
  termId: string;
  zh: string;
  en: string;
  de: string;
  synonyms: string[];
  doNotTranslateAs: string;
}

interface FileReadState {
  bytes: number;
}

const SEVERITIES = new Set([
  'HARD_ISSUE_CANDIDATE',
  'RECOMMENDATION',
  'MANUAL_REVIEW',
  'NO_ISSUE_FOUND_IN_SCOPE',
]);

function isRecord(value: unknown): value is JsonRecord {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function stringValue(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized ? normalized : null;
}

function stringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const result = value.map(stringValue);
  return result.every((item): item is string => !!item) ? result : null;
}

function dateLike(value: unknown): string | null {
  const normalized = stringValue(value);
  if (!normalized) return null;
  return normalized;
}

function addWarning(warnings: string[], warning: string): void {
  if (!warnings.includes(warning)) warnings.push(warning);
}

function safePackageDir(packageDir?: string): string {
  return resolve(packageDir ?? (process.env.KNOWLEDGE_PACKAGE_PATH || join(process.cwd(), 'knowledge-base(2)')));
}

function isWithin(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function assertSafeRoot(packageDir: string): string | null {
  try {
    const stat = lstatSync(packageDir);
    if (stat.isSymbolicLink()) return '知识库目录不能是符号链接';
    if (!stat.isDirectory()) return '知识库路径不是目录';
    // realpathSync catches a directory whose path is reached through an
    // escaped link, while the lstat check above rejects a link at the root.
    const real = realpathSync(packageDir);
    if (!isWithin(resolve(dirname(real)), real)) return '知识库目录路径无效';
    return null;
  } catch (error) {
    return error instanceof Error ? `无法访问知识库目录：${error.message}` : '无法访问知识库目录';
  }
}

function readKnownFile(
  packageDir: string,
  relativePath: string,
  state: FileReadState,
  warnings: string[],
): string | null {
  const target = resolve(packageDir, relativePath);
  if (!isWithin(packageDir, target)) {
    addWarning(warnings, `拒绝越界知识库路径：${relativePath}`);
    return null;
  }

  let current = packageDir;
  const parts = relative(packageDir, target).split(sep).filter(Boolean);
  try {
    for (const part of parts) {
      current = join(current, part);
      const stat = lstatSync(current);
      if (stat.isSymbolicLink()) {
        addWarning(warnings, `拒绝符号链接知识库文件：${relativePath}`);
        return null;
      }
      if (current !== target && !stat.isDirectory()) {
        addWarning(warnings, `知识库路径组件不是目录：${relativePath}`);
        return null;
      }
    }
    const stat = lstatSync(target);
    if (stat.isSymbolicLink()) {
      addWarning(warnings, `拒绝符号链接知识库文件：${relativePath}`);
      return null;
    }
    if (!stat.isFile()) {
      addWarning(warnings, `知识库路径不是普通文件：${relativePath}`);
      return null;
    }
    if (stat.size > MAX_KNOWLEDGE_FILE_BYTES) {
      addWarning(warnings, `知识库文件超过大小限制：${relativePath}`);
      return null;
    }
    if (state.bytes + stat.size > MAX_KNOWLEDGE_TOTAL_BYTES) {
      addWarning(warnings, `知识库文件总量超过大小限制：${relativePath}`);
      return null;
    }
    state.bytes += stat.size;
    return readFileSync(target, 'utf8');
  } catch (error) {
    addWarning(warnings, `无法读取知识库文件 ${relativePath}：${error instanceof Error ? error.message : '未知错误'}`);
    return null;
  }
}

function parseJson(text: string | null, relativePath: string, warnings: string[]): JsonRecord | null {
  if (text === null) return null;
  try {
    const value: unknown = JSON.parse(text);
    if (!isRecord(value)) {
      addWarning(warnings, `${relativePath} 顶层必须是 JSON 对象`);
      return null;
    }
    return value;
  } catch (error) {
    addWarning(warnings, `${relativePath} JSON 无法解析：${error instanceof Error ? error.message : '未知错误'}`);
    return null;
  }
}

function parseJsonLines(text: string | null, relativePath: string, warnings: string[]): JsonRecord[] {
  if (text === null) return [];
  const records: JsonRecord[] = [];
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    try {
      const value: unknown = JSON.parse(line);
      if (!isRecord(value)) {
        addWarning(warnings, `${relativePath}:${index + 1} 必须是 JSON 对象`);
        continue;
      }
      records.push(value);
    } catch (error) {
      addWarning(warnings, `${relativePath}:${index + 1} JSON 无法解析：${error instanceof Error ? error.message : '未知错误'}`);
    }
  }
  return records;
}

function officialEuUrl(value: unknown): string | null {
  const raw = stringValue(value);
  if (!raw) return null;
  try {
    const url = new URL(raw);
    const hostname = url.hostname.toLocaleLowerCase();
    const allowedHost = hostname === 'eur-lex.europa.eu'
      || hostname.endsWith('.eur-lex.europa.eu')
      || hostname === 'ec.europa.eu'
      || hostname.endsWith('.ec.europa.eu');
    // URL normalizes an explicit default :443 away, so inspect the authority
    // as well to reject all explicit ports, credentials, and local hosts.
    const authority = raw.match(/^https:\/\/([^/?#]+)/i)?.[1] ?? '';
    if (url.protocol !== 'https:' || !allowedHost || url.username || url.password || url.port || authority.includes('@') || authority.includes(':')) {
      return null;
    }
    return raw;
  } catch {
    return null;
  }
}

function stableId(kind: string, key: string): string {
  const slug = key.toLocaleLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (slug) return `kbpack-${kind}-${slug}`;
  return `kbpack-${kind}-${createHash('sha256').update(key).digest('hex').slice(0, 16)}`;
}

function unique(values: string[]): string[] {
  return [...new Set(values.map((item) => item.trim()).filter(Boolean))];
}

function metadata(
  context: PackageContext,
  kind: KnowledgeMetadata['kind'],
  synthetic: boolean,
  values: Partial<Pick<KnowledgeMetadata, 'sourceId' | 'sourceUrl' | 'publisher' | 'asOf'>> = {},
): KnowledgeMetadata {
  return {
    kind,
    packageVersion: context.packageVersion,
    packagePath: context.packageDir,
    ...values,
    humanReviewRequired: true,
    synthetic,
  };
}

function makeEntry(
  context: PackageContext,
  id: string,
  title: string,
  content: string,
  tags: string[],
  source: string,
  entryMetadata: KnowledgeMetadata,
): KnowledgeEntry {
  return {
    id,
    title,
    content: content.trim(),
    tags: unique(tags),
    source,
    updatedAt: new Date().toISOString(),
    metadata: entryMetadata,
  };
}

function parseManifest(record: JsonRecord | null, warnings: string[], packageDir: string): PackageContext | null {
  const packageName = stringValue(record?.package_name);
  const packageVersion = stringValue(record?.package_version);
  const dataStatus = stringValue(record?.data_status);
  const scope = isRecord(record?.scope) ? record.scope : null;
  const market = stringValue(scope?.market);
  const productScope = stringValue(scope?.product_scope);
  const ruleVerificationDate = dateLike(record?.rule_verification_date);
  const languages = stringArray(record?.language);
  const excludedConfigurations = stringArray(scope?.excluded_configurations);
  const severityValues = stringArray(record?.severity_values);
  const coverageValues = stringArray(record?.coverage_status_values);
  const files = isRecord(record?.files) ? record.files : null;
  const limitations = stringArray(record?.limitations);
  if (!packageName || !packageVersion || !dataStatus || !market || !productScope || !ruleVerificationDate
    || !languages || !excludedConfigurations || !severityValues || !coverageValues || !files || !limitations
    || !stringValue(record?.synthetic_data_notice) || !stringValue(record?.workflow) || !stringValue(record?.quote_boundary)) {
    addWarning(warnings, 'manifest.json 必填字段或 schema 无效');
    return null;
  }
  if (market !== DEFAULT_MARKET || productScope !== DEFAULT_SCOPE) {
    addWarning(warnings, `知识库范围不在首发范围内：${market}/${productScope}`);
    return null;
  }
  if (dataStatus !== 'synthetic_demo') {
    addWarning(warnings, `知识库 data_status 非 synthetic_demo：${dataStatus}`);
    return null;
  }
  return {
    packageDir,
    packageVersion,
    packageName,
    market,
    productScope,
    ruleVerificationDate,
  };
}

function parseSources(
  record: JsonRecord | null,
  context: PackageContext,
  warnings: string[],
): { sources: KnowledgeSource[]; sourceRecords: Map<string, SourceRecord> } {
  const sourceRecords = new Map<string, SourceRecord>();
  const output: KnowledgeSource[] = [];
  if (!record) return { sources: output, sourceRecords };
  const indexVersion = stringValue(record.index_version);
  const retrievedOn = dateLike(record.retrieved_on);
  const scope = isRecord(record.scope) ? record.scope : null;
  if (!indexVersion || !retrievedOn || stringValue(scope?.market) !== context.market || stringValue(scope?.product_scope) !== context.productScope || !stringValue(scope?.note)) {
    addWarning(warnings, 'public-rules/source-index.json 顶层 schema 无效');
    return { sources: output, sourceRecords };
  }
  const sourceList = record.sources;
  if (!Array.isArray(sourceList)) {
    addWarning(warnings, 'public-rules/source-index.json 缺少 sources 数组');
    return { sources: output, sourceRecords };
  }
  for (const item of sourceList) {
    if (!isRecord(item)) {
      addWarning(warnings, 'source-index.sources 含非对象记录，已跳过');
      continue;
    }
    const sourceId = stringValue(item.source_id);
    const title = stringValue(item.title);
    const url = officialEuUrl(item.url);
    const identifier = stringValue(item.identifier);
    const publisher = stringValue(item.publisher);
    const officialDateOrVersion = stringValue(item.official_date_or_version);
    const retrievedOn = dateLike(item.retrieved_on);
    const topic = stringValue(item.topic);
    const productScopeNote = stringValue(item.product_scope_note);
    if (!sourceId || !title || !url || !identifier || !publisher || !officialDateOrVersion || !retrievedOn || !topic || !productScopeNote) {
      addWarning(warnings, `来源记录字段无效或 URL 非官方 HTTPS：${sourceId ?? '(unknown)'}`);
      continue;
    }
    if (item.human_review_required !== true) {
      addWarning(warnings, `来源未声明 human_review_required=true：${sourceId}`);
      continue;
    }
    if (sourceRecords.has(sourceId)) {
      addWarning(warnings, `来源 source_id 重复，重复记录已跳过：${sourceId}`);
      continue;
    }
    const raw: SourceRecord = {
      sourceId,
      title,
      url,
      identifier,
      publisher,
      officialDateOrVersion,
      retrievedOn,
      topic,
      productScopeNote,
      humanReviewRequired: true,
    };
    sourceRecords.set(sourceId, raw);
    output.push({
      sourceId,
      title,
      url,
      identifier,
      publisher,
      topic,
      scopeNote: productScopeNote,
      asOf: retrievedOn,
      humanReviewRequired: true,
    });
  }
  // Keep the context parameter explicit: it documents that source entries are
  // scoped to this package, while source-index itself is not synthetic data.
  void context;
  return { sources: output, sourceRecords };
}

function parseRules(
  records: JsonRecord[],
  context: PackageContext,
  sourceRecords: Map<string, SourceRecord>,
  warnings: string[],
): { records: RuleRecord[]; byId: Map<string, RuleRecord> } {
  const output: RuleRecord[] = [];
  const byId = new Map<string, RuleRecord>();
  for (const item of records) {
    const ruleId = stringValue(item.rule_id);
    const title = stringValue(item.title);
    const sourceRaw = item.source_id;
    const sourceProvided = sourceRaw !== null && sourceRaw !== undefined;
    const sourceId = sourceProvided ? stringValue(sourceRaw) : null;
    const articleOrSection = stringValue(item.article_or_section);
    const market = stringValue(item.market);
    const productScope = stringValue(item.product_scope);
    const trigger = stringValue(item.trigger);
    const checkItem = stringValue(item.check_item);
    const evidenceExpected = stringArray(item.evidence_expected);
    const severityDefault = stringValue(item.severity_default);
    const decisionLimit = stringValue(item.decision_limit);
    const lastVerified = dateLike(item.last_verified);
    const ruleKind = stringValue(item.rule_kind);
    if (!ruleId || !title || !articleOrSection || !market || !productScope || !trigger || !checkItem || !evidenceExpected || !severityDefault || !decisionLimit || !lastVerified || !ruleKind) {
      addWarning(warnings, `规则卡字段无效，已跳过：${ruleId ?? '(unknown)'}`);
      continue;
    }
    if (!SEVERITIES.has(severityDefault)) {
      addWarning(warnings, `规则卡 severity_default 无效，已跳过：${ruleId}`);
      continue;
    }
    if (market !== context.market || productScope !== context.productScope) {
      addWarning(warnings, `规则卡超出知识库范围，已跳过：${ruleId}`);
      continue;
    }
    if (item.human_review !== true) {
      addWarning(warnings, `规则卡未声明 human_review=true，已跳过：${ruleId}`);
      continue;
    }
    if (sourceProvided && (!sourceId || !sourceRecords.has(sourceId))) {
      addWarning(warnings, `规则卡 source_id 无引用，已跳过：${ruleId}`);
      continue;
    }
    if (byId.has(ruleId)) {
      addWarning(warnings, `rule_id 重复，重复规则卡已跳过：${ruleId}`);
      continue;
    }
    const parsed: RuleRecord = {
      ruleId,
      title,
      sourceId,
      articleOrSection,
      market,
      productScope,
      trigger,
      checkItem,
      evidenceExpected,
      severityDefault,
      decisionLimit,
      lastVerified,
      ruleKind,
    };
    byId.set(ruleId, parsed);
    output.push(parsed);
  }
  return { records: output, byId };
}

function parseChecklist(
  record: JsonRecord | null,
  context: PackageContext,
  rules: Map<string, RuleRecord>,
  warnings: string[],
): ChecklistRecord[] {
  if (!record) return [];
  const market = stringValue(record.market);
  const productScope = stringValue(record.product_scope);
  if (market !== context.market || productScope !== context.productScope) {
    addWarning(warnings, 'checklist.json 超出知识库范围，未导入检查项');
    return [];
  }
  if (!stringValue(record.checklist_id) || !stringValue(record.version) || !dateLike(record.last_verified)) {
    addWarning(warnings, 'checklist.json 缺少 checklist_id/version/last_verified');
    return [];
  }
  if (!Array.isArray(record.items)) {
    addWarning(warnings, 'checklist.json 缺少 items 数组');
    return [];
  }
  const output: ChecklistRecord[] = [];
  const seen = new Set<string>();
  for (const item of record.items) {
    if (!isRecord(item)) {
      addWarning(warnings, 'checklist.items 含非对象记录，已跳过');
      continue;
    }
    const checkId = stringValue(item.check_id);
    const ruleId = stringValue(item.rule_id);
    const name = stringValue(item.name);
    const kind = stringValue(item.kind);
    const requiredDocuments = stringArray(item.required_documents);
    const fields = stringArray(item.fields);
    const evidenceExpected = stringValue(item.evidence_expected);
    const defaultSeverity = stringValue(item.default_severity);
    const ownerRole = stringValue(item.owner_role);
    const decisionLimit = stringValue(item.decision_limit);
    if (!checkId || !ruleId || !name || !kind || !requiredDocuments || !fields || !evidenceExpected || !defaultSeverity || !ownerRole || !decisionLimit) {
      addWarning(warnings, `checklist 检查项字段无效，已跳过：${checkId ?? '(unknown)'}`);
      continue;
    }
    if (!SEVERITIES.has(defaultSeverity)) {
      addWarning(warnings, `checklist default_severity 无效，已跳过：${checkId}`);
      continue;
    }
    if (!rules.has(ruleId)) {
      addWarning(warnings, `checklist rule_id 无引用，已跳过：${checkId}`);
      continue;
    }
    if (seen.has(checkId)) {
      addWarning(warnings, `check_id 重复，重复检查项已跳过：${checkId}`);
      continue;
    }
    seen.add(checkId);
    output.push({
      checkId,
      ruleId,
      name,
      kind,
      requiredDocuments,
      fields,
      evidenceExpected,
      defaultSeverity,
      ownerRole,
      decisionLimit,
    });
  }
  return output;
}

function parseGlossary(record: JsonRecord | null, warnings: string[]): GlossaryRecord[] {
  if (!record) return [];
  if (!stringValue(record.glossary_version) || !stringValue(record.scope) || !Array.isArray(record.terms)) {
    addWarning(warnings, 'glossary/zh-en-de-terms.json 缺少 glossary_version/scope/terms');
    return [];
  }
  const output: GlossaryRecord[] = [];
  const seen = new Set<string>();
  for (const item of record.terms) {
    if (!isRecord(item)) {
      addWarning(warnings, 'glossary.terms 含非对象记录，已跳过');
      continue;
    }
    const termId = stringValue(item.term_id);
    const zh = stringValue(item.zh);
    const en = stringValue(item.en);
    const de = stringValue(item.de);
    const synonyms = stringArray(item.synonyms);
    const doNotTranslateAs = stringValue(item.do_not_translate_as);
    if (!termId || !zh || !en || !de || !synonyms || !doNotTranslateAs) {
      addWarning(warnings, `术语字段无效，已跳过：${termId ?? '(unknown)'}`);
      continue;
    }
    if (seen.has(termId)) {
      addWarning(warnings, `term_id 重复，重复术语已跳过：${termId}`);
      continue;
    }
    seen.add(termId);
    output.push({ termId, zh, en, de, synonyms, doNotTranslateAs });
  }
  return output;
}

function sourceFor(sourcePath: string, id: string): string {
  return `${sourcePath}#${id}`;
}

function sourceMeta(source: SourceRecord): Pick<KnowledgeMetadata, 'sourceId' | 'sourceUrl' | 'publisher' | 'asOf'> {
  return {
    sourceId: source.sourceId,
    sourceUrl: source.url,
    publisher: source.publisher,
    asOf: source.retrievedOn,
  };
}

function buildSourceEntries(context: PackageContext, sourceRecords: Map<string, SourceRecord>): KnowledgeEntry[] {
  return [...sourceRecords.values()].map((source) => makeEntry(
    context,
    stableId('source', source.sourceId),
    source.title,
    [
      `source_id: ${source.sourceId}`,
      `官方发布方：${source.publisher}`,
      `主题：${source.topic}`,
      `官方入口：${source.url}`,
      `官方版本/日期字段：${source.officialDateOrVersion}`,
      `检索日期：${source.retrievedOn}`,
      `适用范围提示：${source.productScopeNote}`,
      '这是公开来源索引和背景依据；生产使用前必须重新核验现行内容、产品适用性和证据充分性，不构成法律意见。',
    ].join('\n'),
    [source.sourceId, source.publisher, source.topic, context.market, context.productScope],
    sourceFor(KNOWN_FILES.sources, source.sourceId),
    metadata(context, 'public_source', false, sourceMeta(source)),
  ));
}

function buildRuleEntries(
  context: PackageContext,
  rules: RuleRecord[],
  sourceRecords: Map<string, SourceRecord>,
): KnowledgeEntry[] {
  return rules.map((rule) => {
    const source = rule.sourceId ? sourceRecords.get(rule.sourceId) : undefined;
    const isPublicRule = !!source;
    const sourceText = source
      ? `公开来源：${source.sourceId}；${source.title}；${source.url}`
      : '来源类型：内部一致性/合成演示规则；没有官方 source_id，不得伪造官方出处。';
    const assumption = isPublicRule
      ? '这是带范围限制的简化规则摘要；法规适用性、证据充分性和最终结论待人工确认。'
      : '这是内部/合成演示规则与简化假设；只能用于流程辅助，适用性和证据结论待人工确认。';
    return makeEntry(
      context,
      stableId('rule', rule.ruleId),
      rule.title,
      [
        `rule_id: ${rule.ruleId}`,
        `触发条件：${rule.trigger}`,
        `检查内容：${rule.checkItem}`,
        `预期证据字段：${rule.evidenceExpected.join(', ')}`,
        `默认风险级别：${rule.severityDefault}`,
        `决定边界：${rule.decisionLimit}`,
        `规则类型：${rule.ruleKind}`,
        sourceText,
        assumption,
      ].join('\n'),
      [rule.ruleId, rule.ruleKind, rule.market, rule.productScope, ...(rule.sourceId ? [rule.sourceId] : [])],
      sourceFor(KNOWN_FILES.rules, rule.ruleId),
      metadata(
        context,
        'guidance',
        !isPublicRule,
        source ? sourceMeta(source) : { asOf: rule.lastVerified },
      ),
    );
  });
}

function buildChecklistEntries(
  context: PackageContext,
  checklist: ChecklistRecord[],
  rules: Map<string, RuleRecord>,
  sourceRecords: Map<string, SourceRecord>,
): KnowledgeEntry[] {
  return checklist.map((item) => {
    const rule = rules.get(item.ruleId);
    const source = rule?.sourceId ? sourceRecords.get(rule.sourceId) : undefined;
    const isPublicRule = !!source;
    const sourceText = source
      ? `关联公开来源：${source.sourceId}；${source.url}`
      : '关联内部/合成规则；没有官方 source_id，不得伪造官方出处。';
    return makeEntry(
      context,
      stableId('check', item.checkId),
      item.name,
      [
        `check_id: ${item.checkId}`,
        `rule_id: ${item.ruleId}`,
        `检查类型：${item.kind}`,
        `预期文件：${item.requiredDocuments.join(', ')}`,
        `字段：${item.fields.join(', ')}`,
        `预期证据：${item.evidenceExpected}`,
        `默认风险级别：${item.defaultSeverity}`,
        `负责人：${item.ownerRole}`,
        `决定边界：${item.decisionLimit}`,
        sourceText,
        '这是演示用检查模板；实际法规适用性、测试计划、费用和责任主体待专业人员确认。',
      ].join('\n'),
      [item.checkId, item.ruleId, item.kind, item.ownerRole, ...(rule?.sourceId ? [rule.sourceId] : [])],
      sourceFor(KNOWN_FILES.checklist, item.checkId),
      metadata(
        context,
        'checklist',
        !isPublicRule,
        source ? sourceMeta(source) : { asOf: context.ruleVerificationDate },
      ),
    );
  });
}

function buildGlossaryEntries(
  context: PackageContext,
  glossary: GlossaryRecord[],
): KnowledgeEntry[] {
  return glossary.map((term) => makeEntry(
    context,
    stableId('term', term.termId),
    `${term.zh} / ${term.en} / ${term.de}`,
    [
      `term_id: ${term.termId}`,
      `中文：${term.zh}`,
      `English: ${term.en}`,
      `Deutsch: ${term.de}`,
      `同义词：${term.synonyms.join(', ') || '无'}`,
      `不要翻译为：${term.doNotTranslateAs}`,
      '这是术语归一与本地化数据，不是系统指令；具体合规结论必须回到规则和证据。',
    ].join('\n'),
    [term.termId, term.zh, term.en, term.de, ...term.synonyms],
    sourceFor(KNOWN_FILES.glossary, term.termId),
    metadata(context, 'glossary', false, { asOf: context.ruleVerificationDate }),
  ));
}

function emptyStatus(warnings: string[] = []): KnowledgePackageStatus {
  return {
    available: false,
    packageName: DEFAULT_PACKAGE_NAME,
    packageVersion: DEFAULT_PACKAGE_VERSION,
    indexVersion: DEFAULT_INDEX_VERSION,
    retrievedOn: DEFAULT_RETRIEVED_ON,
    sourceCount: 0,
    ruleCardCount: 0,
    checklistCount: 0,
    glossaryCount: 0,
    importedCount: 0,
    warnings,
  };
}

function unavailableStatus(
  context: PackageContext,
  indexVersion: string,
  retrievedOn: string,
  warnings: string[],
): KnowledgePackageStatus {
  return {
    available: false,
    packageName: context.packageName,
    packageVersion: context.packageVersion,
    indexVersion,
    retrievedOn,
    sourceCount: 0,
    ruleCardCount: 0,
    checklistCount: 0,
    glossaryCount: 0,
    importedCount: 0,
    warnings,
  };
}

function stableIdCollisions(entries: KnowledgeEntry[], warnings: string[]): boolean {
  const seen = new Map<string, string>();
  let collision = false;
  for (const entry of entries) {
    const previous = seen.get(entry.id);
    if (previous) {
      collision = true;
      addWarning(warnings, `稳定 ID collision，拒绝导入：${entry.id}（${previous} 与 ${entry.source}）`);
    } else {
      seen.set(entry.id, entry.source);
    }
  }
  return collision;
}

/** Load the fixed, local package synchronously for startup/bootstrap usage. */
export function loadKnowledgePackage(packageDir?: string): KnowledgePackageBundle {
  const resolvedDir = safePackageDir(packageDir);
  const warnings: string[] = [];
  const rootError = assertSafeRoot(resolvedDir);
  if (rootError) {
    addWarning(warnings, rootError);
    addWarning(warnings, `知识库不可用：${resolvedDir}`);
    return { status: emptyStatus(warnings), sources: [], entries: [] };
  }

  const state: FileReadState = { bytes: 0 };
  const manifest = parseManifest(
    parseJson(readKnownFile(resolvedDir, KNOWN_FILES.manifest, state, warnings), KNOWN_FILES.manifest, warnings),
    warnings,
    resolvedDir,
  );
  if (!manifest) {
    addWarning(warnings, '知识库 manifest 无效，未导入任何条目');
    return { status: emptyStatus(warnings), sources: [], entries: [] };
  }

  const sourceIndex = parseJson(
    readKnownFile(resolvedDir, KNOWN_FILES.sources, state, warnings),
    KNOWN_FILES.sources,
    warnings,
  );
  const { sources, sourceRecords } = parseSources(sourceIndex, manifest, warnings);
  const ruleLines = parseJsonLines(
    readKnownFile(resolvedDir, KNOWN_FILES.rules, state, warnings),
    KNOWN_FILES.rules,
    warnings,
  );
  const { records: rules, byId: ruleMap } = parseRules(ruleLines, manifest, sourceRecords, warnings);
  const checklist = parseChecklist(
    parseJson(readKnownFile(resolvedDir, KNOWN_FILES.checklist, state, warnings), KNOWN_FILES.checklist, warnings),
    manifest,
    ruleMap,
    warnings,
  );
  const glossary = parseGlossary(
    parseJson(readKnownFile(resolvedDir, KNOWN_FILES.glossary, state, warnings), KNOWN_FILES.glossary, warnings),
    warnings,
  );

  const entries = [
    ...buildSourceEntries(manifest, sourceRecords),
    ...buildRuleEntries(manifest, rules, sourceRecords),
    ...buildChecklistEntries(manifest, checklist, ruleMap, sourceRecords),
    ...buildGlossaryEntries(manifest, glossary),
  ];
  const indexVersion = stringValue(sourceIndex?.index_version) ?? DEFAULT_INDEX_VERSION;
  const retrievedOn = dateLike(sourceIndex?.retrieved_on) ?? manifest.ruleVerificationDate;
  if (stableIdCollisions(entries, warnings)) {
    return {
      status: unavailableStatus(manifest, indexVersion, retrievedOn, warnings),
      sources: [],
      entries: [],
    };
  }
  const status: KnowledgePackageStatus = {
    available: true,
    packageName: manifest.packageName,
    packageVersion: manifest.packageVersion,
    indexVersion,
    retrievedOn,
    sourceCount: sources.length,
    ruleCardCount: rules.length,
    checklistCount: checklist.length,
    glossaryCount: glossary.length,
    importedCount: entries.length,
    warnings,
  };
  return { status, sources, entries };
}

function protectedSource(source: string): boolean {
  const normalized = source.toLocaleLowerCase();
  return normalized === 'manual' || normalized.includes('obsidian');
}

function sameEntryIgnoringUpdatedAt(a: KnowledgeEntry, b: KnowledgeEntry): boolean {
  return a.id === b.id
    && a.title === b.title
    && a.content === b.content
    && a.source === b.source
    && JSON.stringify(a.tags) === JSON.stringify(b.tags)
    && JSON.stringify(a.metadata ?? null) === JSON.stringify(b.metadata ?? null);
}

/** Synchronize package entries without touching manual or Obsidian entries. */
export function syncKnowledgePackage(
  db: Pick<AppDatabase, 'listKnowledge' | 'saveKnowledge'>,
  packageDir?: string,
): KnowledgePackageBundle {
  const bundle = loadKnowledgePackage(packageDir);
  if (!bundle.status.available) return bundle;
  const existing = db.listKnowledge();
  const byId = new Map(existing.map((entry) => [entry.id, entry]));
  const now = new Date().toISOString();
  const managedEntries: KnowledgeEntry[] = [];
  for (const imported of bundle.entries) {
    const current = byId.get(imported.id);
    if (current && protectedSource(current.source)) continue;
    const next: KnowledgeEntry = {
      ...imported,
      // Preserve an unchanged timestamp while still passing the complete
      // bundle to the database transaction for stale-row deletion.
      updatedAt: current && sameEntryIgnoringUpdatedAt(current, imported)
        ? current.updatedAt
        : now,
    };
    managedEntries.push(next);
  }
  const transactionalDb = db as Pick<AppDatabase, 'listKnowledge' | 'saveKnowledge'> & Partial<Pick<AppDatabase, 'syncManagedKnowledge'>>;
  if (transactionalDb.syncManagedKnowledge) {
    transactionalDb.syncManagedKnowledge(safePackageDir(packageDir), managedEntries);
    return bundle;
  }
  // Keep the small structural helper usable by tests and lightweight callers
  // that only expose list/save. The real AppDatabase always takes the atomic
  // path above; this fallback cannot remove stale rows without a delete API.
  for (const next of managedEntries) {
    const current = byId.get(next.id);
    if (current && sameEntryIgnoringUpdatedAt(current, next)) continue;
    db.saveKnowledge(next);
    byId.set(next.id, next);
  }
  return bundle;
}

function queryTokens(query: string): string[] {
  const normalized = query.toLocaleLowerCase().trim();
  if (!normalized) return [];
  const tokens = new Set<string>();
  try {
    const segmenter = new Intl.Segmenter('zh-CN', { granularity: 'word' });
    for (const part of segmenter.segment(normalized)) {
      if (part.isWordLike && part.segment.trim()) tokens.add(part.segment.trim());
    }
  } catch {
    // Node 24 supports Intl.Segmenter; regex remains a safe fallback for
    // alternate runtimes used by tooling.
  }
  for (const match of normalized.matchAll(/[\p{L}\p{N}][\p{L}\p{N}_-]*/gu)) tokens.add(match[0]);
  tokens.add(normalized);
  return [...tokens].filter(Boolean);
}

/** Search title/tags/content with multilingual tokenization and stable ties. */
export function searchKnowledge(
  entries: KnowledgeEntry[],
  query: string,
  limit = 6,
  options: KnowledgeSearchOptions = {},
): KnowledgeEntry[] {
  const tokens = queryTokens(query);
  if (!tokens.length || limit <= 0) return [];
  const includeSynthetic = options.includeSynthetic === true;
  const ranked = entries
    .filter((entry) => includeSynthetic || entry.metadata?.synthetic !== true)
    .map((entry) => {
      const title = entry.title.toLocaleLowerCase();
      const tags = entry.tags.map((tag) => tag.toLocaleLowerCase());
      const content = entry.content.toLocaleLowerCase();
      const haystack = `${title}\n${content}\n${tags.join(' ')}`;
      let score = 0;
      for (const token of tokens) {
        if (title.includes(token)) score += 16;
        if (tags.some((tag) => tag === token)) score += 12;
        else if (tags.some((tag) => tag.includes(token))) score += 7;
        if (content.includes(token)) score += 3;
      }
      if (haystack.includes(query.toLocaleLowerCase().trim())) score += 8;
      return { entry, score };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.entry.id.localeCompare(b.entry.id));
  return ranked.slice(0, Math.max(0, Math.floor(limit))).map((item) => item.entry);
}


import { randomUUID } from 'node:crypto';
import { lstat, readFile, readdir } from 'node:fs/promises';
import { basename, extname, relative, resolve } from 'node:path';
import type { Coverage, EvidencePage, EvidenceReport, KnowledgeEntry } from '../shared/types.js';

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
export const TEST_SCOPE_IDS = ['temperature', 'ip', 'emc', 'rohs', 'electrical-strength'] as const;
const MAX_VAULT_FILES = 200;
const MAX_VAULT_FILE_BYTES = 1 * 1024 * 1024;
const MAX_VAULT_TOTAL_BYTES = 20 * 1024 * 1024;

export interface UploadInput {
  originalname: string;
  mimetype?: string;
  buffer: Buffer;
}

export interface ParsedUpload {
  report: EvidenceReport;
  text: string;
  error?: string;
}

function now(): string {
  return new Date().toISOString();
}

function kindFor(filename: string, text = ''): EvidenceReport['kind'] {
  const value = `${filename} ${text.slice(0, 800)}`.toLocaleLowerCase();
  if (/emc|电磁/.test(value)) return 'emc';
  if (/rohs|reach|材料/.test(value)) return 'rohs';
  if (/spec|规格|参数/.test(value)) return 'spec';
  if (/label|标签/.test(value)) return 'label';
  if (/manual|说明书|手册/.test(value)) return 'manual';
  if (/doc|声明|declaration|合规/.test(value)) return 'doc';
  if (/safety|安规|温升|ip20|ip44/.test(value)) return 'safety';
  return 'other';
}

function unique(values: string[]): string[] {
  return [...new Set(values.map((item) => item.trim()).filter(Boolean))];
}

export function draftCoverageFromText(text: string): Coverage {
  const powers = [...text.matchAll(/(\d+(?:\.\d+)?)\s*(?:-|~|至)\s*(\d+(?:\.\d+)?)\s*W\b/gi)]
    .flatMap((match) => [Number(match[1]), Number(match[2])]);
  const singles = [...text.matchAll(/\b(\d+(?:\.\d+)?)\s*W\b/gi)].map((match) => Number(match[1]));
  const allPowers = [...powers, ...singles].filter(Number.isFinite);
  const ipLevels = unique([...text.matchAll(/\bIP\s*\d{2}\b/gi)].map((match) => match[0].replace(/\s+/g, '').toUpperCase()));
  const drivers = unique([...text.matchAll(/\bDRV[-_ ]?[A-Za-z0-9]+\b/gi)].map((match) => match[0].replace(/[_ ]/g, '-').toUpperCase()));
  const tests = unique([
    ...(/EMC|电磁/i.test(text) ? ['emc'] : []),
    ...(/RoHS|REACH/i.test(text) ? ['rohs'] : []),
    ...(/温升|耐热|thermal/i.test(text) ? ['temperature'] : []),
    ...(/防尘|防水|IP\s*\d{2}/i.test(text) ? ['ip'] : []),
    ...(/电气强度|绝缘|安规|safety/i.test(text) ? ['electrical-strength'] : []),
  ]);
  const materials = unique([
    ...(/original-material/i.test(text) ? ['original-material'] : []),
    ...(/铝|alumin/i.test(text) ? ['aluminium'] : []),
    ...(/PCB/i.test(text) ? ['PCB'] : []),
  ]);
  const markets = unique([
    ...(/德国|germany|\bDE\b/i.test(text) ? ['DE'] : []),
    ...(/欧盟|欧洲|\bEU\b/i.test(text) ? ['EU'] : []),
  ]);
  const series = text.match(/\b(NL[-_ ]?[A-Z0-9]+)\b/i)?.[1]?.replace(/[_ ]/g, '-') ?? null;
  return {
    series,
    powerMinW: allPowers.length ? Math.min(...allPowers) : null,
    powerMaxW: allPowers.length ? Math.max(...allPowers) : null,
    ipLevels,
    drivers,
    materials,
    markets,
    tests,
    confidence: text.trim() ? 0.35 : 0,
  };
}

function pagesFromText(text: string): EvidencePage[] {
  const parts = text.split('\f');
  return (parts.length ? parts : [text]).map((page, index) => ({ page: index + 1, text: page.trim().slice(0, 200_000) }));
}

function coverageFromObject(value: unknown): Coverage | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  const required = ['series', 'powerMinW', 'powerMaxW', 'ipLevels', 'drivers', 'materials', 'markets', 'tests', 'confidence'];
  if (required.some((key) => !(key in item))) return null;
  const strings = (key: string): string[] | null => {
    if (!Array.isArray(item[key]) || item[key].some((entry) => typeof entry !== 'string')) return null;
    return item[key].map((entry) => (entry as string).trim()).filter(Boolean);
  };
  const numberOrNull = (key: string): number | null | undefined => {
    if (item[key] === null) return null;
    return typeof item[key] === 'number' && Number.isFinite(item[key]) && (item[key] as number) >= 0 ? item[key] as number : undefined;
  };
  const series = item.series === null || typeof item.series === 'string' ? item.series as string | null : undefined;
  const confidence = typeof item.confidence === 'number' && Number.isFinite(item.confidence) && item.confidence >= 0 && item.confidence <= 1 ? item.confidence : undefined;
  const ipLevels = strings('ipLevels');
  const drivers = strings('drivers');
  const materials = strings('materials');
  const markets = strings('markets');
  const tests = strings('tests');
  const powerMinW = numberOrNull('powerMinW');
  const powerMaxW = numberOrNull('powerMaxW');
  if (series === undefined || confidence === undefined || ipLevels === null || drivers === null || materials === null || markets === null || tests === null || powerMinW === undefined || powerMaxW === undefined) return null;
  return {
    series: series ? series.trim() || null : null,
    powerMinW, powerMaxW,
    ipLevels, drivers, materials, markets, tests, confidence,
  };
}

function kindFromValue(value: unknown, fallback: EvidenceReport['kind']): EvidenceReport['kind'] {
  return typeof value === 'string' && ['safety', 'emc', 'rohs', 'spec', 'doc', 'label', 'manual', 'other'].includes(value) ? value as EvidenceReport['kind'] : fallback;
}

function structuredJson(value: unknown): { title?: string; kind?: EvidenceReport['kind']; coverage?: Coverage; pages?: EvidencePage[]; testScopes?: EvidenceReport['testScopes'] } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const record = value as Record<string, unknown>;
  const pages = Array.isArray(record.pages) ? record.pages.map((page) => {
    if (!page || typeof page !== 'object') return null;
    const item = page as Record<string, unknown>;
    return typeof item.page === 'number' && Number.isInteger(item.page) && item.page > 0 && typeof item.text === 'string'
      ? { page: item.page, text: item.text.slice(0, 200_000) } : null;
  }).filter((page): page is EvidencePage => !!page) : undefined;
  const testScopes: EvidenceReport['testScopes'] = {};
  if (record.testScopes && typeof record.testScopes === 'object' && !Array.isArray(record.testScopes)) {
    for (const [test, scope] of Object.entries(record.testScopes)) {
      if (!scope || typeof scope !== 'object') continue;
      const item = scope as Record<string, unknown>;
      const coverage = coverageFromObject(item.coverage);
      if (coverage && typeof item.page === 'number' && Number.isInteger(item.page) && item.page > 0) {
        testScopes[test] = { coverage, page: item.page, ...(typeof item.quote === 'string' ? { quote: item.quote } : {}) };
      }
    }
  }
  return {
    title: typeof record.title === 'string' && record.title.trim() ? record.title.trim() : undefined,
    kind: typeof record.kind === 'string' && ['safety', 'emc', 'rohs', 'spec', 'doc', 'label', 'manual', 'other'].includes(record.kind)
      ? kindFromValue(record.kind, 'other') : undefined,
    coverage: coverageFromObject(record.coverage) ?? undefined,
    pages,
    ...(Object.keys(testScopes).length ? { testScopes } : {}),
  };
}

async function extractPdf(buffer: Buffer): Promise<{ text: string; pages: EvidencePage[]; pageCount: number }> {
  const module = await import('pdf-parse') as unknown as Record<string, unknown>;
  const Parser = module.PDFParse as (new (options: { data: Buffer }) => { getText: () => Promise<unknown>; destroy?: () => Promise<void> }) | undefined;
  if (Parser) {
    const parser = new Parser({ data: buffer });
    try {
      const result = await parser.getText() as { text?: string; total?: number; pages?: Array<{ text?: string }> };
      const text = result.text ?? '';
      const pageTexts = result.pages?.map((page) => page.text ?? '') ?? [];
      const pageCount = result.total || pageTexts.length || 0;
      const pages = pageTexts.length ? pageTexts.map((page, index) => ({ page: index + 1, text: page.slice(0, 200_000) })) : Array.from({ length: pageCount }, (_, index) => ({ page: index + 1, text: '' }));
      return { text, pages, pageCount };
    } finally {
      await parser.destroy?.();
    }
  }
  const legacy = (module.default ?? module) as ((data: Buffer) => Promise<{ text?: string; numpages?: number }>);
  if (typeof legacy !== 'function') throw new Error('pdf-parse API 不可用');
  const result = await legacy(buffer);
  const text = result.text ?? '';
  const pages = pagesFromText(text);
  const pageCount = Math.max(result.numpages || 0, pages.length || 0);
  const byNumber = new Map(pages.map((page) => [page.page, page]));
  const normalizedPages = Array.from({ length: pageCount }, (_, index) => byNumber.get(index + 1) ?? { page: index + 1, text: '' });
  return { text, pages: normalizedPages, pageCount };
}

export async function parseUpload(input: UploadInput): Promise<ParsedUpload> {
  const ext = extname(input.originalname).toLocaleLowerCase();
  const allowed = new Set(['.txt', '.md', '.markdown', '.json', '.pdf']);
  if (!allowed.has(ext)) throw new Error('只支持 TXT、MD、JSON、PDF 文件');
  if (input.buffer.byteLength > MAX_UPLOAD_BYTES) throw new Error('文件超过 10MB 限制');

  const createdAt = now();
  const id = `report-${randomUUID()}`;
  let text = '';
  let pages: EvidencePage[] = [];
  let pageCount = 0;
  let status: EvidenceReport['status'] = 'ready';
  let notes = '已上传，覆盖范围为自动草稿，需人工确认。';
  let error: string | undefined;
  let structured: ReturnType<typeof structuredJson> = {};
  try {
    if (ext === '.pdf') {
      const extracted = await extractPdf(input.buffer);
      text = extracted.text;
      pages = extracted.pages;
      pageCount = extracted.pageCount;
      if (!text.trim()) {
        status = 'needs_review';
        notes = 'PDF 没有可提取文字，可能是扫描件；请人工补录覆盖范围和页码。';
      } else if (pages.some((page) => !page.text.trim())) {
        status = 'needs_review';
        notes = 'PDF 仅部分页面可提取文字，覆盖范围需人工确认。';
      }
    } else {
      text = input.buffer.toString('utf8');
      if (ext === '.json') {
        try {
          const parsed = JSON.parse(text) as unknown;
          structured = structuredJson(parsed);
          text = JSON.stringify(parsed, null, 2);
        } catch {
          status = 'needs_review';
          notes = 'JSON 无法解析，已保留原文，覆盖范围需人工确认。';
        }
      }
      if (ext === '.json' && structured.pages !== undefined) {
        // Structured JSON page numbers are source evidence and must not be
        // renumbered. Missing/duplicate pages remain visible to the later
        // confirmation check instead of being silently repaired.
        pages = structured.pages;
        pageCount = pages.reduce((maximum, page) => Math.max(maximum, page.page), 0);
        if (!pages.length || !pageCount) {
          status = 'needs_review';
          notes = `${notes} JSON 未提供可核验页码。`;
        }
      } else {
        pages = pagesFromText(text);
        pageCount = pages.length;
      }
    }
  } catch (caught) {
    status = 'failed';
    error = caught instanceof Error ? caught.message : '文件解析失败';
    notes = `文件解析失败：${error}`;
    text = '';
    pages = [];
    pageCount = 0;
  }
  if (text.includes('\uFFFD')) {
    status = status === 'failed' ? status : 'needs_review';
    notes = `${notes} 文本包含无法确认的字符编码。`;
  }
  const report: EvidenceReport = {
    id,
    title: structured.title ?? basename(input.originalname, ext),
    kind: structured.kind ?? kindFor(input.originalname, text),
    source: 'uploaded',
    status,
    filename: input.originalname,
    pageCount,
    pages,
    coverage: structured.coverage ?? draftCoverageFromText(text),
    verified: false,
    notes,
    createdAt,
    ...(structured.testScopes ? { testScopes: structured.testScopes } : {}),
  };
  return { report, text, ...(error ? { error } : {}) };
}

export function validateCoverageConfirmation(report: EvidenceReport, coverage: Coverage): string | null {
  if (report.status === 'failed') return '解析失败的报告不能确认覆盖范围';
  const shapeError = validateCoverageShape(coverage);
  if (shapeError) return shapeError;
  const value = coverage as unknown as Record<string, unknown>;
  if (report.testScopes) {
    const scopes = normalizeTestScopes(report, report.testScopes);
    if (scopes.error) return scopes.error;
  }
  if (!Number.isInteger(report.pageCount) || report.pageCount < 1 || !Array.isArray(report.pages) || !report.pages.length) return '报告没有可核验页码，不能确认覆盖范围';
  const pages = new Set<number>();
  for (const page of report.pages) {
    if (!page || typeof page !== 'object' || !Number.isInteger(page.page) || page.page < 1 || page.page > report.pageCount) return '报告页码无效';
    if (pages.has(page.page)) return '报告页码重复';
    pages.add(page.page);
    if (typeof page.text !== 'string') return '报告页正文必须是字符串';
    if (!page.text.trim()) return '报告包含空白页，不能自动确认覆盖范围';
  }
  if (pages.size !== report.pageCount || [...Array(report.pageCount)].some((_, index) => !pages.has(index + 1))) return '报告页码不完整';
  return null;
}

function validateCoverageShape(coverage: unknown): string | null {
  if (!coverage || typeof coverage !== 'object' || Array.isArray(coverage)) return 'coverage 必须是对象';
  const value = coverage as Record<string, unknown>;
  if (value.series !== null && typeof value.series !== 'string') return 'series 必须是字符串或 null';
  for (const key of ['ipLevels', 'drivers', 'materials', 'markets', 'tests']) {
    if (!Array.isArray(value[key]) || (value[key] as unknown[]).some((entry) => typeof entry !== 'string')) {
      return `coverage.${key} 必须是字符串数组`;
    }
  }
  for (const key of ['powerMinW', 'powerMaxW']) {
    const candidate = value[key];
    if (!(key in value) || (candidate !== null && (typeof candidate !== 'number' || !Number.isFinite(candidate) || candidate < 0))) return `${key} 必须是非负数字或 null`;
  }
  const powerMinW = value.powerMinW as number | null;
  const powerMaxW = value.powerMaxW as number | null;
  if (powerMinW !== null && powerMaxW !== null && powerMinW > powerMaxW) return '功率范围无效';
  if (typeof value.confidence !== 'number' || !Number.isFinite(value.confidence)) return 'confidence 必须是有限数字';
  if (value.confidence < 0 || value.confidence > 1) return 'confidence 必须在 0 到 1 之间';
  if (!Array.isArray(value.tests) || !(value.tests as unknown[]).length) return '至少需要一个测试项目';
  return null;
}

export function normalizeTestScopes(report: EvidenceReport, value: unknown): { scopes?: NonNullable<EvidenceReport['testScopes']>; error?: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { error: 'testScopes 必须是对象' };
  if (!Array.isArray(report.pages)) return { error: '报告页正文不可用，不能确认测试项目范围' };
  const scopes: NonNullable<EvidenceReport['testScopes']> = {};
  for (const [test, rawScope] of Object.entries(value)) {
    if (!(TEST_SCOPE_IDS as readonly string[]).includes(test)) return { error: `testScopes.${test} 不是受支持的测试项目` };
    if (!rawScope || typeof rawScope !== 'object' || Array.isArray(rawScope)) return { error: `testScopes.${test} 必须是对象` };
    const scope = rawScope as Record<string, unknown>;
    const coverageError = validateCoverageShape(scope.coverage);
    if (coverageError) return { error: `testScopes.${test}.coverage 无效：${coverageError}` };
    const coverage = scope.coverage as Coverage;
    if (!coverage.tests.includes(test)) return { error: `testScopes.${test}.coverage.tests 必须包含 ${test}` };
    if (typeof scope.page !== 'number' || !Number.isInteger(scope.page) || scope.page < 1) return { error: `testScopes.${test}.page 必须是正整数` };
    const page = report.pages.find((item) => item.page === scope.page);
    if (!page) return { error: `testScopes.${test}.page 不存在于报告页码中` };
    const suppliedQuote = typeof scope.quote === 'string' ? scope.quote : '';
    const quote = suppliedQuote.trim() && page.text.includes(suppliedQuote) ? suppliedQuote : page.text;
    scopes[test] = { coverage, page: scope.page, quote };
  }
  return { scopes };
}

async function collectMarkdown(root: string): Promise<Array<{ path: string; text: string }>> {
  const rootStat = await lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error('OBSIDIAN_VAULT_PATH 必须是非符号链接目录');
  const output: Array<{ path: string; text: string }> = [];
  let totalBytes = 0;
  async function visit(directory: string): Promise<void> {
    if (output.length >= MAX_VAULT_FILES) return;
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (output.length >= MAX_VAULT_FILES) break;
      const path = resolve(directory, entry.name);
      const stat = await lstat(path);
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) {
        await visit(path);
      } else if (stat.isFile() && extname(entry.name).toLocaleLowerCase() === '.md') {
        if (stat.size > MAX_VAULT_FILE_BYTES || totalBytes + stat.size > MAX_VAULT_TOTAL_BYTES) continue;
        const text = await readFile(path, 'utf8');
        totalBytes += stat.size;
        output.push({ path, text });
      }
    }
  }
  await visit(root);
  return output;
}

export async function importMarkdownVault(): Promise<{ entries: KnowledgeEntry[]; skipped: number }> {
  const root = process.env.OBSIDIAN_VAULT_PATH;
  if (!root) throw new Error('未配置 OBSIDIAN_VAULT_PATH');
  const files = await collectMarkdown(resolve(root));
  const entries = files.map(({ path, text }) => ({
    id: `knowledge-${randomUUID()}`,
    title: basename(path, extname(path)),
    content: text,
    tags: ['obsidian', relative(resolve(root), path)],
    source: 'obsidian-vault',
    updatedAt: now(),
  }));
  return { entries, skipped: Math.max(0, files.length - entries.length) };
}


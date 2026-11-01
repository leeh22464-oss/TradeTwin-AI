import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  CostItem,
  Coverage,
  EvidencePage,
  EvidenceReport,
  KnowledgeProvenance,
  ProductConfig,
  RuleDefinition,
  RuntimeKnowledgeContext,
} from '../shared/types.js';

/**
 * The runtime profile is deliberately separate from server/seed.ts.  The
 * latter is retained for old cases and backwards compatibility, while this
 * loader is the only source of the verified synthetic knowledge used by new
 * deterministic analyses.
 */

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(MODULE_DIR, '..');
const DEFAULT_PACKAGE_PATH = join(PROJECT_ROOT, 'knowledge-base(2)');
const DEFAULT_POLICY_PATH = join(PROJECT_ROOT, 'knowledge', 'runtime-profile.json');
const MAX_FILE_BYTES = 4 * 1024 * 1024;
const PROFILE_ID = 'tradetwin-runtime-kb-demo';
const PROFILE_VERSION = 'rules-2026.10.31-demo.v2+kb.0.2.0';
const CREATED_AT = '2026-10-31T00:00:00.000Z';

const PACKAGE_FILES = {
  canonical: 'synthetic-data/canonical-product.json',
  spec: 'synthetic-data/packs/baseline/02-product-spec.md',
  doc: 'synthetic-data/packs/baseline/03-declaration-of-conformity.md',
  test: 'synthetic-data/packs/baseline/04-test-report.md',
  label: 'synthetic-data/packs/baseline/05-label-and-instructions.md',
  rules: 'public-rules/rule-cards.jsonl',
} as const;

const EXPECTED_COST_IDS = [
  'temperature',
  'ip',
  'emc',
  'electrical-strength',
  'rohs',
  'document-update',
  'driver-preparation',
] as const;

const TEST_IDS = ['temperature', 'ip', 'emc', 'rohs', 'electrical-strength'] as const;

type TestId = typeof TEST_IDS[number];
type RawRecord = Record<string, unknown>;

export interface RuntimeCostPolicy {
  id: string;
  title: string;
  feeEur: number;
  days: number;
  group: CostItem['group'];
}

export interface RuntimeKnowledgePolicy {
  profileId: string;
  version: string;
  requireEmcReview: boolean;
  driverPreparationDays: number;
  ruleIds: Record<string, string[]>;
  modelAliases: Record<string, string[]>;
  costs: RuntimeCostPolicy[];
}

export interface RuntimeKnowledgeProfile {
  available: boolean;
  warnings: string[];
  baseConfig: ProductConfig;
  reports: EvidenceReport[];
  rules: RuleDefinition[];
  costs: CostItem[];
  policy: RuntimeKnowledgePolicy;
  context: RuntimeKnowledgeContext;
  notes?: string[];
}

export interface LoadRuntimeKnowledgeOptions {
  packagePath?: string;
  policyPath?: string;
}

interface ReadArtifact {
  absolutePath: string;
  displayPath: string;
  sha256: string;
  bytes: Buffer;
  text: string;
}

interface ParsedDocument {
  documentId: string;
  documentType: string;
  synthetic: boolean;
  pages: EvidencePage[];
}

interface CanonicalProduct {
  model: string;
  sampleModel: string;
  powerW: number;
  ip: string;
  driver: string;
  market: string;
  material: string;
  series: string;
  reportId: string;
  reportPowerMinW: number;
  reportPowerMaxW: number;
  reportIp: string;
  reportDriver: string;
  reportTests: string[];
}

const EMPTY_CONFIG: ProductConfig = {
  model: '', powerW: null, ip: null, driver: null, material: null, market: null,
};

const EMPTY_POLICY: RuntimeKnowledgePolicy = {
  profileId: 'unavailable',
  version: 'unavailable',
  requireEmcReview: true,
  driverPreparationDays: 0,
  ruleIds: {},
  modelAliases: {},
  costs: [],
};

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as RawRecord;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function pathInside(root: string, candidate: string): boolean {
  const rootResolved = resolve(root);
  const candidateResolved = resolve(candidate);
  const remainder = relative(rootResolved, candidateResolved);
  return remainder === '' || (remainder !== '..' && !remainder.startsWith(`..${sep}`) && !isAbsolute(remainder));
}

function isSymlink(pathname: string): boolean {
  try {
    return lstatSync(pathname).isSymbolicLink();
  } catch {
    return false;
  }
}

function resolveRoot(rawPath: string, label: string): { path: string; realPath: string } {
  const candidate = isAbsolute(rawPath) ? resolve(rawPath) : resolve(PROJECT_ROOT, rawPath);
  const stat = lstatSync(candidate);
  if (!stat.isDirectory()) throw new Error(`${label} 不是目录：${rawPath}`);
  if (stat.isSymbolicLink()) throw new Error(`${label} 不允许是符号链接：${rawPath}`);
  return { path: candidate, realPath: realpathSync(candidate) };
}

function assertNoSymlinkInRelativePath(root: string, relativePath: string): void {
  let cursor = root;
  for (const part of relativePath.split(/[\\/]/u).filter(Boolean)) {
    cursor = join(cursor, part);
    if (isSymlink(cursor)) throw new Error(`知识源路径包含不允许的符号链接：${relativePath}`);
  }
}

function sourceDisplayPath(absolutePath: string): string {
  const resolved = resolve(absolutePath);
  if (pathInside(PROJECT_ROOT, resolved)) return relative(PROJECT_ROOT, resolved).split(sep).join('/');
  // A temporary package used by a validation test is outside the repository.
  // Keep its real path so the API can resolve the provenance link rather than
  // returning a decorative/virtual filename.
  return resolved;
}

function readPackageFile(root: { path: string; realPath: string }, relativePath: string): ReadArtifact {
  if (!pathInside(root.path, resolve(root.path, relativePath))) throw new Error(`知识源路径越界：${relativePath}`);
  assertNoSymlinkInRelativePath(root.path, relativePath);
  const candidate = resolve(root.path, relativePath);
  const stat = lstatSync(candidate);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`知识源不是普通文件：${relativePath}`);
  if (stat.size > MAX_FILE_BYTES) throw new Error(`知识源文件过大：${relativePath}`);
  const realCandidate = realpathSync(candidate);
  if (!pathInside(root.realPath, realCandidate)) throw new Error(`知识源真实路径越界：${relativePath}`);
  const bytes = readFileSync(candidate);
  return {
    absolutePath: candidate,
    displayPath: sourceDisplayPath(candidate),
    sha256: sha256(bytes),
    bytes,
    text: bytes.toString('utf8'),
  };
}

function readPolicyFile(rawPath: string): ReadArtifact {
  const candidate = isAbsolute(rawPath) ? resolve(rawPath) : resolve(PROJECT_ROOT, rawPath);
  const stat = lstatSync(candidate);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`policy 不是普通文件：${rawPath}`);
  if (extname(candidate).toLowerCase() !== '.json') throw new Error(`policy 必须是 JSON 文件：${rawPath}`);
  if (stat.size > MAX_FILE_BYTES) throw new Error('policy 文件过大');
  const realCandidate = realpathSync(candidate);
  const bytes = readFileSync(candidate);
  return {
    absolutePath: candidate,
    displayPath: sourceDisplayPath(candidate),
    sha256: sha256(bytes),
    bytes,
    text: bytes.toString('utf8'),
  };
}

function readPolicyMarkdown(rawPath: string): ReadArtifact {
  const jsonPath = isAbsolute(rawPath) ? resolve(rawPath) : resolve(PROJECT_ROOT, rawPath);
  const candidate = join(dirname(jsonPath), `${basename(jsonPath, extname(jsonPath))}.md`);
  const stat = lstatSync(candidate);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`policy 说明文档不是普通文件：${candidate}`);
  if (stat.size > MAX_FILE_BYTES) throw new Error('policy 说明文档过大');
  const bytes = readFileSync(candidate);
  return {
    absolutePath: candidate,
    displayPath: sourceDisplayPath(candidate),
    sha256: sha256(bytes),
    bytes,
    text: bytes.toString('utf8'),
  };
}

function requireRecord(value: unknown, label: string): RawRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} 必须是对象`);
  return value as RawRecord;
}

function requiredString(record: RawRecord, key: string, label: string): string {
  const value = record[key];
  if (typeof value !== 'string' || value.trim().length === 0) throw new Error(`${label}.${key} 必须是非空字符串`);
  return value.trim();
}

function requiredBoolean(record: RawRecord, key: string, label: string): boolean {
  if (typeof record[key] !== 'boolean') throw new Error(`${label}.${key} 必须是布尔值`);
  return record[key] as boolean;
}

function finiteNumber(value: unknown, label: string, options: { integer?: boolean; min?: number } = {}): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${label} 必须是有限数字`);
  if (options.integer && !Number.isInteger(value)) throw new Error(`${label} 必须是整数`);
  if (options.min !== undefined && value < options.min) throw new Error(`${label} 不能小于 ${options.min}`);
  return value;
}

function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || item.trim().length === 0)) {
    throw new Error(`${label} 必须是非空字符串数组`);
  }
  return value.map((item) => (item as string).trim());
}

function parseJson(text: string, label: string): unknown {
  try {
    return JSON.parse(text.replace(/^\uFEFF/u, ''));
  } catch (error) {
    throw new Error(`${label} JSON 无法解析：${error instanceof Error ? error.message : String(error)}`);
  }
}

function parseDocument(artifact: ReadArtifact): ParsedDocument {
  const idMatch = /`document_id`\s*:\s*`([^`]+)`/u.exec(artifact.text);
  const typeMatch = /`document_type`\s*:\s*(?:`([^`]+)`|([^\s\r\n]+))/u.exec(artifact.text);
  const syntheticMatch = /`synthetic`\s*:\s*(true|false)/u.exec(artifact.text);
  if (!idMatch || !typeMatch || !syntheticMatch) throw new Error(`文档元数据不完整：${artifact.displayPath}`);
  const markers = [...artifact.text.matchAll(/^##\s*第\s*(\d+)\s*页\s*\r?$/gmu)];
  if (markers.length === 0) throw new Error(`文档缺少“## 第 N 页”页码：${artifact.displayPath}`);
  const pages: EvidencePage[] = markers.map((marker, index) => {
    const page = Number(marker[1]);
    if (!Number.isInteger(page) || page !== index + 1) throw new Error(`文档页码不连续：${artifact.displayPath}`);
    const start = (marker.index ?? 0) + marker[0].length;
    const end = index + 1 < markers.length ? (markers[index + 1].index ?? artifact.text.length) : artifact.text.length;
    const text = artifact.text.slice(start, end).trim();
    if (!text) throw new Error(`文档第 ${page} 页为空：${artifact.displayPath}`);
    return { page, text };
  });
  return { documentId: idMatch[1], documentType: typeMatch[1] ?? typeMatch[2], synthetic: syntheticMatch[1] === 'true', pages };
}

function parseCanonical(artifact: ReadArtifact): CanonicalProduct {
  const root = requireRecord(parseJson(artifact.text, artifact.displayPath), artifact.displayPath);
  if (root.synthetic !== true || root.data_status !== 'synthetic_demo') throw new Error(`canonical 不是 synthetic_demo：${artifact.displayPath}`);
  const product = requireRecord(root.canonical_product, `${artifact.displayPath}.canonical_product`);
  const model = requiredString(product, 'model', 'canonical_product');
  const market = requiredString(product, 'market', 'canonical_product');
  const ip = requiredString(product, 'protection_rating', 'canonical_product');
  const driver = requiredString(product, 'driver_model', 'canonical_product');
  const powerW = finiteNumber(product.rated_power_w, 'canonical_product.rated_power_w', { min: 0 });
  const sample = requireRecord(product.test_sample, 'canonical_product.test_sample');
  requiredString(sample, 'sample_id', 'canonical_product.test_sample');
  const sampleModel = requiredString(sample, 'sample_model', 'canonical_product.test_sample');
  if (sampleModel !== model) throw new Error(`canonical_product.test_sample.sample_model 与 canonical_product.model 不一致：${sampleModel} / ${model}`);
  const coverage = requireRecord(product.report_coverage, 'canonical_product.report_coverage');
  const reportId = requiredString(coverage, 'report_id', 'canonical_product.report_coverage');
  const range = requireRecord(coverage.power_range_w, 'canonical_product.report_coverage.power_range_w');
  const reportPowerMinW = finiteNumber(range.min, 'canonical_product.report_coverage.power_range_w.min', { min: 0 });
  const reportPowerMaxW = finiteNumber(range.max, 'canonical_product.report_coverage.power_range_w.max', { min: reportPowerMinW });
  const reportIp = requiredString(coverage, 'protection_rating', 'canonical_product.report_coverage');
  const reportDriver = requiredString(coverage, 'driver_model', 'canonical_product.report_coverage');
  const reportTests = stringArray(coverage.covered_test_items, 'canonical_product.report_coverage.covered_test_items');
  if (!reportTests.length) throw new Error('canonical_product.report_coverage.covered_test_items 不能为空');
  return {
    model, sampleModel, powerW, ip, driver, market,
    // The canonical file has no material field. This is the explicit demo
    // assumption documented in knowledge/runtime-profile.md.
    material: 'original-material',
    // The source only declares the concrete sample/model (NL-L24). Do not
    // infer a broader family from a shared string prefix; the legacy NL-L
    // spelling is handled by the explicit runtime modelAliases policy.
    series: model, reportId, reportPowerMinW, reportPowerMaxW,
    reportIp, reportDriver, reportTests,
  };
}

function parsePolicy(artifact: ReadArtifact): RuntimeKnowledgePolicy {
  const root = requireRecord(parseJson(artifact.text, artifact.displayPath), artifact.displayPath);
  const profileId = requiredString(root, 'profileId', artifact.displayPath);
  const version = requiredString(root, 'version', artifact.displayPath);
  if (profileId !== PROFILE_ID) throw new Error(`policy.profileId 不受支持：${profileId}`);
  if (version !== PROFILE_VERSION) throw new Error(`policy.version 不受支持：${version}`);
  const requireEmcReview = requiredBoolean(root, 'requireEmcReview', artifact.displayPath);
  if (!requireEmcReview) throw new Error('policy.requireEmcReview 必须为 true');
  const driverPreparationDays = finiteNumber(root.driverPreparationDays, 'policy.driverPreparationDays', { integer: true, min: 0 });
  const ruleIdsRecord = requireRecord(root.ruleIds, 'policy.ruleIds');
  const ruleIds: Record<string, string[]> = {};
  for (const [key, value] of Object.entries(ruleIdsRecord)) ruleIds[key] = stringArray(value, `policy.ruleIds.${key}`);
  const requiredRuleKeys = ['coverage', 'mapping', 'minimumRetest', 'driverReuse', 'documentUpdate', 'quoteAssumption', 'contract'];
  for (const key of requiredRuleKeys) if (!ruleIds[key]) throw new Error(`policy.ruleIds 缺少 ${key}`);
  const aliasesRecord = requireRecord(root.modelAliases, 'policy.modelAliases');
  const modelAliases: Record<string, string[]> = {};
  for (const [key, value] of Object.entries(aliasesRecord)) modelAliases[key] = stringArray(value, `policy.modelAliases.${key}`);
  if (JSON.stringify(modelAliases) !== JSON.stringify({ 'NL-L': ['NL-L24'] })) throw new Error('policy.modelAliases 只能声明 NL-L → NL-L24');
  const rawCosts = root.costs;
  if (!Array.isArray(rawCosts)) throw new Error('policy.costs 必须是数组');
  const seen = new Set<string>();
  const costs: RuntimeCostPolicy[] = rawCosts.map((value, index) => {
    const row = requireRecord(value, `policy.costs[${index}]`);
    const id = requiredString(row, 'id', `policy.costs[${index}]`);
    if (seen.has(id)) throw new Error(`policy.costs 存在重复 id：${id}`);
    seen.add(id);
    const group = requiredString(row, 'group', `policy.costs[${index}]`) as CostItem['group'];
    if (!['test', 'document', 'preparation'].includes(group)) throw new Error(`policy.costs.${id}.group 无效`);
    return {
      id,
      title: requiredString(row, 'title', `policy.costs[${index}]`),
      feeEur: finiteNumber(row.feeEur, `policy.costs.${id}.feeEur`, { min: 0 }),
      days: finiteNumber(row.days, `policy.costs.${id}.days`, { integer: true, min: 0 }),
      group,
    };
  });
  const actualIds = costs.map((item) => item.id).sort();
  const expectedIds = [...EXPECTED_COST_IDS].sort();
  if (JSON.stringify(actualIds) !== JSON.stringify(expectedIds)) throw new Error('policy.costs 必须完整覆盖演示费用项目');
  const preparation = costs.find((item) => item.id === 'driver-preparation');
  if (!preparation || preparation.group !== 'preparation' || preparation.days !== driverPreparationDays) {
    throw new Error('driver-preparation 必须与 policy.driverPreparationDays 一致');
  }
  return { profileId, version, requireEmcReview, driverPreparationDays, ruleIds, modelAliases, costs };
}

function parsePageRange(text: string): { min: number; max: number } | undefined {
  const match = /(?:覆盖功率区间|功率范围)[^\d]*(\d+(?:\.\d+)?)\s*[–—-]\s*(\d+(?:\.\d+)?)\s*W/iu.exec(text);
  if (!match) return undefined;
  const min = Number(match[1]);
  const max = Number(match[2]);
  if (!Number.isFinite(min) || !Number.isFinite(max) || min > max) throw new Error('测试报告功率范围无效');
  return { min, max };
}

function parseProfileElectricalRange(text: string): { min: number; max: number } {
  const row = text.split(/\r?\n/u).find((line) => /^\|\s*electrical-strength\s*\|/iu.test(line));
  const match = row?.match(/(\d+(?:\.\d+)?)\s*[–—-]\s*(\d+(?:\.\d+)?)\s*W/iu);
  if (!match) throw new Error('runtime-profile.md 缺少 electrical-strength 功率范围');
  const min = Number(match[1]);
  const max = Number(match[2]);
  if (!Number.isFinite(min) || !Number.isFinite(max) || min > max) throw new Error('runtime-profile.md 功率范围无效');
  return { min, max };
}

function validateRangeConsistency(canonical: CanonicalProduct, testArtifact: ReadArtifact, profileArtifact: ReadArtifact): void {
  const test = parseDocument(testArtifact);
  const page = test.pages.find((item) => item.page === 2);
  if (!page) throw new Error('基准测试报告必须存在第 2 页');
  const sourceRange = parsePageRange(page.text);
  if (!sourceRange) throw new Error('基准测试报告第 2 页缺少覆盖功率区间');
  const documentedRange = parseProfileElectricalRange(profileArtifact.text);
  const equal = (left: { min: number; max: number }, right: { min: number; max: number }) => left.min === right.min && left.max === right.max;
  const canonicalRange = { min: canonical.reportPowerMinW, max: canonical.reportPowerMaxW };
  if (!equal(canonicalRange, sourceRange) || !equal(canonicalRange, documentedRange)) {
    throw new Error(`功率范围来源不一致：canonical=${canonicalRange.min}–${canonicalRange.max}W，报告=${sourceRange.min}–${sourceRange.max}W，runtime-profile.md=${documentedRange.min}–${documentedRange.max}W`);
  }
}

function parsePageIp(text: string): string | undefined {
  return /(?:覆盖防护等级|防护等级)\s*[:：]?\s*`?(IP\d{2})`?/iu.exec(text)?.[1]?.toUpperCase();
}

function parsePageDriver(text: string): string | undefined {
  return /(?:覆盖驱动电源|驱动电源)\s*[:：]?\s*`?([A-Z0-9_-]+)`?/iu.exec(text)?.[1]?.toUpperCase();
}

function requireFieldValue(pages: EvidencePage[], fieldPattern: RegExp, expected: string, label: string): void {
  const expectedToken = `\`${expected}\``;
  const match = pages.some((page) => fieldPattern.test(page.text) && page.text.includes(expectedToken));
  if (!match) throw new Error(`${label} 未找到与 canonical 一致的字段值：${expected}`);
}

function validateTestReportIdentity(canonical: CanonicalProduct, document: ParsedDocument): void {
  const page = document.pages.find((item) => item.page === 1);
  if (!page) throw new Error('基准测试报告必须存在第 1 页');
  requireFieldValue(page ? [page] : [], /报告编号/iu, canonical.reportId, '测试报告第 1 页报告编号');
  requireFieldValue(page ? [page] : [], /样品型号/iu, canonical.sampleModel, '测试报告第 1 页样品型号');
}

function validateDocumentIdentity(canonical: CanonicalProduct, document: ParsedDocument, kind: 'spec' | 'doc'): void {
  const field = kind === 'spec' ? /型号\s*\/\s*SKU/iu : /声明对象型号/iu;
  requireFieldValue(document.pages, field, canonical.model, `${kind === 'spec' ? '规格书' : 'DoC'} 型号`);
}

function marketsFor(canonical: CanonicalProduct): string[] {
  const values = [canonical.market.toUpperCase(), 'DE'];
  return [...new Set(values)];
}

function coverage(input: Partial<Coverage> & Pick<Coverage, 'tests'>): Coverage {
  return {
    series: input.series ?? null,
    powerMinW: input.powerMinW ?? null,
    powerMaxW: input.powerMaxW ?? null,
    ipLevels: input.ipLevels ?? [],
    drivers: input.drivers ?? [],
    materials: input.materials ?? [],
    markets: input.markets ?? [],
    tests: input.tests,
    confidence: input.confidence ?? 0.9,
  };
}

function knowledgeSource(artifact: ReadArtifact, documentId?: string, page?: number, ruleId?: string): KnowledgeProvenance {
  return {
    path: artifact.displayPath,
    ...(documentId ? { documentId } : {}),
    ...(page !== undefined ? { page } : {}),
    ...(ruleId ? { ruleId } : {}),
    sha256: artifact.sha256,
  };
}

function buildReport(
  artifact: ReadArtifact,
  document: ParsedDocument,
  id: string,
  title: string,
  kind: EvidenceReport['kind'],
  reportCoverage: Coverage,
  testScopes?: EvidenceReport['testScopes'],
): EvidenceReport {
  if (!document.synthetic) throw new Error(`证据文档未标记 synthetic=true：${artifact.displayPath}`);
  const report: EvidenceReport = {
    id,
    title,
    kind,
    source: 'synthetic',
    status: 'ready',
    filename: basename(artifact.absolutePath),
    filenameEncoding: 'utf-8',
    pageCount: document.pages.length,
    pages: document.pages,
    coverage: reportCoverage,
    verified: true,
    notes: '合成演示数据；演示预设确认状态，不代表真实工程/品质确认或检测机构结论。',
    createdAt: CREATED_AT,
    ...(testScopes ? { testScopes } : {}),
    knowledgeSource: knowledgeSource(artifact, document.documentId),
  };
  // Keep every scoped citation tied to the exact page body that was parsed.
  for (const [test, scope] of Object.entries(report.testScopes ?? {})) {
    const page = report.pages.find((item) => item.page === scope.page);
    if (!page || !scope.quote || !page.text.includes(scope.quote)) throw new Error(`证据 scope ${test} 的 quote 不在原文页内：${artifact.displayPath}`);
  }
  return report;
}

function reportTests(canonical: CanonicalProduct): string[] {
  const map: Record<string, string> = {
    thermal_rise: 'temperature',
    electrical_safety: 'electrical-strength',
    EMC: 'emc',
    RoHS_document_review: 'rohs',
  };
  return [...new Set(canonical.reportTests.map((item) => map[item] ?? item).filter((item) => TEST_IDS.includes(item as TestId)))];
}

function buildEvidenceReports(
  canonical: CanonicalProduct,
  specArtifact: ReadArtifact,
  docArtifact: ReadArtifact,
  testArtifact: ReadArtifact,
  labelArtifact: ReadArtifact,
): EvidenceReport[] {
  const spec = parseDocument(specArtifact);
  const doc = parseDocument(docArtifact);
  const test = parseDocument(testArtifact);
  const label = parseDocument(labelArtifact);
  validateDocumentIdentity(canonical, spec, 'spec');
  validateDocumentIdentity(canonical, doc, 'doc');
  validateTestReportIdentity(canonical, test);
  const markets = marketsFor(canonical);
  const testPage2 = test.pages.find((page) => page.page === 2);
  if (!testPage2) throw new Error('基准测试报告必须存在第 2 页');
  const pageRange = parsePageRange(testPage2.text);
  if (!pageRange) throw new Error('基准测试报告第 2 页缺少覆盖功率区间');
  const powerMinW = pageRange.min;
  const powerMaxW = pageRange.max;
  const reportIp = parsePageIp(testPage2.text);
  const reportDriver = parsePageDriver(testPage2.text);
  if (!reportIp) throw new Error('基准测试报告第 2 页缺少覆盖防护等级');
  if (!reportDriver) throw new Error('基准测试报告第 2 页缺少覆盖驱动电源');
  if (reportIp !== canonical.reportIp.toUpperCase()) throw new Error(`测试报告覆盖防护等级与 canonical 不一致：${reportIp} / ${canonical.reportIp}`);
  if (reportDriver !== canonical.reportDriver.toUpperCase()) throw new Error(`测试报告覆盖驱动电源与 canonical 不一致：${reportDriver} / ${canonical.reportDriver}`);
  const series = canonical.series;
  const reportTestIds = reportTests(canonical);
  if (!reportTestIds.length) throw new Error('基准测试报告没有可映射的测试项目');
  const scopeQuote = testPage2.text;
  const scopes: NonNullable<EvidenceReport['testScopes']> = {
    temperature: {
      coverage: coverage({ series, powerMinW, powerMaxW, drivers: [reportDriver], markets, tests: ['temperature'] }),
      page: 2, quote: scopeQuote,
    },
    ip: {
      coverage: coverage({ series, ipLevels: [reportIp], markets, tests: ['ip'] }),
      page: 2, quote: scopeQuote,
    },
    emc: {
      coverage: coverage({ series, powerMinW, powerMaxW, drivers: [reportDriver], materials: [canonical.material], markets, tests: ['emc'] }),
      page: 2, quote: scopeQuote,
    },
    'electrical-strength': {
      // The real package does not provide an 18–40W electrical-strength
      // scope. Keep it at the report's 18–30W boundary.
      coverage: coverage({ series, powerMinW, powerMaxW, drivers: [reportDriver], markets, tests: ['electrical-strength'] }),
      page: 2, quote: scopeQuote,
    },
    rohs: {
      coverage: coverage({ series, materials: [canonical.material], markets, tests: ['rohs'] }),
      page: 2, quote: scopeQuote,
    },
  };
  const reportCoverage = coverage({
    series, powerMinW, powerMaxW, ipLevels: [reportIp], drivers: [reportDriver], materials: [canonical.material], markets,
    tests: reportTestIds,
  });
  const reports: EvidenceReport[] = [
    buildReport(testArtifact, test, canonical.reportId, `测试报告 ${canonical.reportId}（合成演示）`, 'safety', reportCoverage, scopes),
    buildReport(
      specArtifact,
      spec,
      spec.documentId,
      `产品规格书 ${canonical.model}（合成演示）`,
      'spec',
      coverage({ series, powerMinW: canonical.powerW, powerMaxW: canonical.powerW, ipLevels: [canonical.ip], drivers: [canonical.driver], materials: [canonical.material], markets, tests: ['spec'] }),
    ),
    buildReport(
      docArtifact,
      doc,
      doc.documentId,
      `EU DoC ${canonical.model}（合成演示）`,
      'doc',
      coverage({ series, powerMinW: canonical.powerW, powerMaxW: canonical.powerW, ipLevels: [canonical.ip], drivers: [canonical.driver], materials: [canonical.material], markets, tests: ['doc'] }),
    ),
  ];
  const labelCoverage = coverage({
    series, powerMinW: canonical.powerW, powerMaxW: canonical.powerW, ipLevels: [canonical.ip], drivers: [canonical.driver], materials: [canonical.material], markets,
    tests: ['label', 'manual'],
  });
  reports.push(buildReport(
    labelArtifact,
    label,
    label.documentId,
    `标签与说明书 ${canonical.model}（组合演示）`,
    'label',
    labelCoverage,
    {
      label: { coverage: { ...labelCoverage, tests: ['label'] }, page: 1, quote: label.pages.find((page) => page.page === 1)?.text ?? '' },
      manual: { coverage: { ...labelCoverage, tests: ['manual'] }, page: 2, quote: label.pages.find((page) => page.page === 2)?.text ?? '' },
    },
  ));
  return reports;
}

function categoryForRuleKind(ruleKind: string): string {
  if (ruleKind.includes('coverage')) return 'coverage';
  if (ruleKind.includes('mapping') || ruleKind.includes('reuse') || ruleKind.includes('retest')) return 'mapping';
  if (ruleKind.includes('document') || ruleKind.includes('delivery')) return 'documents';
  if (ruleKind.includes('quote')) return 'quote';
  if (ruleKind.includes('completeness') || ruleKind.includes('presence')) return 'safety';
  return 'review';
}

function buildRules(artifact: ReadArtifact, policy: RuntimeKnowledgePolicy): RuleDefinition[] {
  const rules: RuleDefinition[] = [];
  const seen = new Set<string>();
  for (const [lineIndex, line] of artifact.text.split(/\r?\n/u).entries()) {
    if (!line.trim()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      throw new Error(`规则卡第 ${lineIndex + 1} 行 JSON 无法解析：${error instanceof Error ? error.message : String(error)}`);
    }
    const row = requireRecord(parsed, `规则卡第 ${lineIndex + 1} 行`);
    const id = requiredString(row, 'rule_id', `规则卡第 ${lineIndex + 1} 行`);
    if (seen.has(id)) throw new Error(`规则卡重复：${id}`);
    seen.add(id);
    const title = requiredString(row, 'title', `规则卡 ${id}`);
    const checkItem = requiredString(row, 'check_item', `规则卡 ${id}`);
    const decisionLimit = requiredString(row, 'decision_limit', `规则卡 ${id}`);
    const ruleKind = requiredString(row, 'rule_kind', `规则卡 ${id}`);
    rules.push({
      id,
      title,
      description: `${checkItem}。${decisionLimit}`,
      category: categoryForRuleKind(ruleKind),
      version: policy.version,
      knowledgeSource: knowledgeSource(artifact, undefined, undefined, id),
    });
  }
  if (!rules.length) throw new Error('规则卡为空');
  const ids = new Set(rules.map((rule) => rule.id));
  for (const [key, required] of Object.entries(policy.ruleIds)) {
    for (const id of required) if (!ids.has(id)) throw new Error(`policy.ruleIds.${key} 引用了不存在的规则：${id}`);
  }
  return rules;
}

function buildCosts(policyArtifact: ReadArtifact, policy: RuntimeKnowledgePolicy, profileArtifact: ReadArtifact): CostItem[] {
  return policy.costs.map((item) => ({
    id: item.id,
    title: item.title,
    feeEur: item.feeEur,
    days: item.days,
    group: item.group,
    // The three-day preparation item is explicitly justified in the checked
    // Markdown policy note; keep that provenance separate from the JSON fee
    // table so the source link explains the serial lead-time assumption.
    knowledgeSource: knowledgeSource(item.id === 'driver-preparation' ? profileArtifact : policyArtifact, policy.profileId),
  }));
}

function buildContext(artifacts: ReadArtifact[], policy: RuntimeKnowledgePolicy): RuntimeKnowledgeContext {
  const sources = artifacts.map((artifact) => knowledgeSource(artifact));
  const fingerprintInput = artifacts
    .map((artifact) => ({ path: artifact.displayPath, sha256: artifact.sha256 }))
    .sort((a, b) => a.path.localeCompare(b.path));
  const fingerprint = sha256(Buffer.from(canonicalJson({ profileId: policy.profileId, version: policy.version, sources: fingerprintInput }), 'utf8'));
  return { profileId: policy.profileId, version: policy.version, fingerprint, sources };
}

function failureProfile(warnings: string[], policy = EMPTY_POLICY, artifacts: ReadArtifact[] = []): RuntimeKnowledgeProfile {
  const context = buildContext(artifacts, policy);
  return {
    available: false,
    warnings: [...new Set(warnings)],
    baseConfig: { ...EMPTY_CONFIG },
    reports: [],
    rules: [],
    costs: [],
    policy,
    context,
    notes: ['运行时知识 profile 不可用；不得将旧 seed 数据冒充为已验证知识。'],
  };
}

/** Load and validate the allowlisted synthetic knowledge package. */
export function loadRuntimeKnowledge(options: LoadRuntimeKnowledgeOptions = {}): RuntimeKnowledgeProfile {
  const artifacts: ReadArtifact[] = [];
  try {
    const packageRoot = resolveRoot(options.packagePath ?? DEFAULT_PACKAGE_PATH, 'knowledge package');
    const policyArtifact = readPolicyFile(options.policyPath ?? DEFAULT_POLICY_PATH);
    const profileArtifact = readPolicyMarkdown(options.policyPath ?? DEFAULT_POLICY_PATH);
    artifacts.push(policyArtifact, profileArtifact);
    const policy = parsePolicy(policyArtifact);
    const canonicalArtifact = readPackageFile(packageRoot, PACKAGE_FILES.canonical);
    const specArtifact = readPackageFile(packageRoot, PACKAGE_FILES.spec);
    const docArtifact = readPackageFile(packageRoot, PACKAGE_FILES.doc);
    const testArtifact = readPackageFile(packageRoot, PACKAGE_FILES.test);
    const labelArtifact = readPackageFile(packageRoot, PACKAGE_FILES.label);
    const rulesArtifact = readPackageFile(packageRoot, PACKAGE_FILES.rules);
    artifacts.push(canonicalArtifact, specArtifact, docArtifact, testArtifact, labelArtifact, rulesArtifact);
    const canonical = parseCanonical(canonicalArtifact);
    validateRangeConsistency(canonical, testArtifact, profileArtifact);
    const reports = buildEvidenceReports(canonical, specArtifact, docArtifact, testArtifact, labelArtifact);
    const rules = buildRules(rulesArtifact, policy);
    const costs = buildCosts(policyArtifact, policy, profileArtifact);
    const context = buildContext(artifacts, policy);
    const baseConfig: ProductConfig = {
      model: canonical.model,
      powerW: canonical.powerW,
      ip: canonical.ip,
      driver: canonical.driver,
      material: canonical.material,
      market: 'DE',
    };
    return {
      available: true,
      warnings: ['费用、周期、报告与参数映射均为 synthetic_demo，必须由工程/品质和检测机构人工确认。'],
      baseConfig,
      reports,
      rules,
      costs,
      policy,
      context,
      notes: [
        '本 profile 只读取固定知识包文件；不读取 test-cases/expected-results.json。',
        'original-material 是项目演示假设，不是 canonical-product.json 的原始字段。',
      ],
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return failureProfile([`运行时知识 profile 不可用：${detail}`], EMPTY_POLICY, artifacts);
  }
}

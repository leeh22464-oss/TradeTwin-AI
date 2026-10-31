import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import type { KnowledgeEntry } from '../shared/types.js';
import { AppDatabase } from '../server/db.js';
import { loadKnowledgePackage, searchKnowledge, syncKnowledgePackage } from '../server/knowledge.js';

const PACKAGE_DIR = resolve(process.cwd(), 'knowledge-base(2)');

function clonePackage(): string {
  const target = mkdtempSync(join(tmpdir(), 'tradetwin-knowledge-'));
  cpSync(PACKAGE_DIR, target, { recursive: true });
  return target;
}

function fakeDb(initial: KnowledgeEntry[] = []) {
  const values = new Map(initial.map((entry) => [entry.id, entry]));
  const saves: KnowledgeEntry[] = [];
  return {
    values,
    saves,
    listKnowledge: () => [...values.values()],
    saveKnowledge: (entry: KnowledgeEntry) => {
      saves.push(entry);
      values.set(entry.id, entry);
      return entry;
    },
  };
}

function makeLegacyEntry(id: string, source: string, title: string): KnowledgeEntry {
  return { id, source, title, content: title, tags: ['legacy'], updatedAt: '2026-10-31T00:00:00.000Z' };
}

describe('knowledge package import', () => {
  it('loads only the four approved structured files and imports 54 entries', () => {
    const bundle = loadKnowledgePackage(PACKAGE_DIR);

    expect(bundle.status.available).toBe(true);
    expect(bundle.status.packageVersion).toBe('0.2.0');
    expect(bundle.status.indexVersion).toBe('0.1.0');
    expect(bundle.status.sourceCount).toBe(6);
    expect(bundle.status.ruleCardCount).toBe(16);
    expect(bundle.status.checklistCount).toBe(16);
    expect(bundle.status.glossaryCount).toBe(16);
    expect(bundle.status.importedCount).toBe(54);
    expect(bundle.entries).toHaveLength(54);
    expect(new Set(bundle.entries.map((entry) => entry.id)).size).toBe(54);
    expect(bundle.status.warnings).toEqual([]);

    const publicRules = bundle.entries.filter((entry) => entry.metadata?.kind === 'guidance' && entry.metadata.synthetic === false);
    const internalRules = bundle.entries.filter((entry) => entry.metadata?.kind === 'guidance' && entry.metadata.synthetic === true);
    const publicChecks = bundle.entries.filter((entry) => entry.metadata?.kind === 'checklist' && entry.metadata.synthetic === false);
    const internalChecks = bundle.entries.filter((entry) => entry.metadata?.kind === 'checklist' && entry.metadata.synthetic === true);
    expect(publicRules).toHaveLength(7);
    expect(internalRules).toHaveLength(9);
    expect(publicChecks).toHaveLength(7);
    expect(internalChecks).toHaveLength(9);

    expect(bundle.entries.every((entry) => !entry.source.includes('synthetic-data/') && !entry.source.includes('test-cases/') && !entry.source.includes('handoff/'))).toBe(true);
    expect(bundle.sources.every((source) => source.url.startsWith('https://'))).toBe(true);
    expect(bundle.entries.filter((entry) => entry.metadata?.kind === 'guidance' && entry.metadata?.synthetic === true)
      .every((entry) => !entry.metadata?.sourceId && !entry.metadata?.sourceUrl)).toBe(true);
  });

  it('keeps source references scoped and rejects bad URLs and duplicate IDs', () => {
    const packageDir = clonePackage();
    const sourcePath = join(packageDir, 'public-rules/source-index.json');
    const sourceIndex = JSON.parse(readFileSync(sourcePath, 'utf8')) as { sources: Array<Record<string, unknown>> };
    sourceIndex.sources[0].url = 'http://localhost:8080/not-an-official-source';
    sourceIndex.sources.push({ ...sourceIndex.sources[1] });
    writeFileSync(sourcePath, JSON.stringify(sourceIndex, null, 2));

    const rulesPath = join(packageDir, 'public-rules/rule-cards.jsonl');
    appendFileSync(rulesPath, `\n${JSON.stringify({
      rule_id: 'RULE-UNKNOWN-SOURCE-999',
      title: 'bad source reference',
      source_id: 'SRC-NOT-IN-INDEX',
      article_or_section: 'fixture',
      market: 'EU',
      product_scope: 'indoor_fixed_led_luminaire',
      trigger: 'fixture',
      check_item: 'fixture',
      evidence_expected: ['document_id'],
      severity_default: 'MANUAL_REVIEW',
      decision_limit: 'fixture',
      human_review: true,
      last_verified: '2026-10-31',
      rule_kind: 'fixture',
    })}\n`);

    const bundle = loadKnowledgePackage(packageDir);
    expect(bundle.sources.some((source) => source.sourceId === 'SRC-CE-MARKING')).toBe(false);
    expect(bundle.sources.some((source) => source.sourceId === 'SRC-LVD-2014-35')).toBe(true);
    expect(bundle.status.sourceCount).toBe(5);
    expect(bundle.entries.some((entry) => entry.metadata?.sourceId === 'SRC-CE-MARKING')).toBe(false);
    expect(bundle.entries.some((entry) => entry.id.includes('unknown-source-999'))).toBe(false);
    expect(bundle.status.warnings.some((warning) => warning.includes('URL 非官方 HTTPS'))).toBe(true);
    expect(bundle.status.warnings.some((warning) => warning.includes('source_id 重复'))).toBe(true);
    expect(bundle.status.warnings.some((warning) => warning.includes('无引用'))).toBe(true);
    rmSync(packageDir, { recursive: true, force: true });
  });

  it('reports missing packages and rejects symlinked known files without crashing callers', () => {
    const missing = join(mkdtempSync(join(tmpdir(), 'tradetwin-knowledge-missing-')), 'not-present');
    const missingBundle = loadKnowledgePackage(missing);
    expect(missingBundle.status.available).toBe(false);
    expect(missingBundle.status.warnings.length).toBeGreaterThan(0);
    expect(missingBundle.entries).toEqual([]);

    const packageDir = clonePackage();
    const sourcePath = join(packageDir, 'public-rules/source-index.json');
    const outside = join(tmpdir(), `tradetwin-outside-${Date.now()}.json`);
    writeFileSync(outside, readFileSync(sourcePath));
    rmSync(sourcePath);
    let supported = true;
    try {
      symlinkSync(outside, sourcePath);
    } catch {
      supported = false;
    }
    if (supported) {
      const bundle = loadKnowledgePackage(packageDir);
      expect(bundle.status.available).toBe(true);
      expect(bundle.sources).toEqual([]);
      expect(bundle.status.warnings.some((warning) => warning.includes('符号链接'))).toBe(true);
    }
    rmSync(packageDir, { recursive: true, force: true });
    if (existsSync(outside)) rmSync(outside, { force: true });
  });
});

describe('knowledge package sync and search', () => {
  it('is idempotent and does not overwrite manual or Obsidian entries', () => {
    const manual = makeLegacyEntry('manual-1', 'manual', '人工笔记');
    const obsidian = makeLegacyEntry('obsidian-1', 'obsidian-vault', 'Obsidian 笔记');
    const db = fakeDb([manual, obsidian]);

    syncKnowledgePackage(db, PACKAGE_DIR);
    expect(db.saves).toHaveLength(54);
    const importedId = 'kbpack-source-src-ce-marking';
    const firstUpdatedAt = db.values.get(importedId)?.updatedAt;
    expect(firstUpdatedAt).toBeTruthy();
    expect(db.values.get(manual.id)).toEqual(manual);
    expect(db.values.get(obsidian.id)).toEqual(obsidian);

    syncKnowledgePackage(db, PACKAGE_DIR);
    expect(db.saves).toHaveLength(54);
    expect(db.values.get(importedId)?.updatedAt).toBe(firstUpdatedAt);
    expect(db.values.get(manual.id)).toEqual(manual);
    expect(db.values.get(obsidian.id)).toEqual(obsidian);
  });

  it('supports Chinese, German and glossary-synonym searches while isolating synthetic guidance by default', () => {
    const bundle = loadKnowledgePackage(PACKAGE_DIR);
    const chinese = searchKnowledge(bundle.entries, '输入电压');
    expect(chinese.length).toBeGreaterThan(0);
    expect(chinese.every((entry) => entry.metadata?.synthetic !== true)).toBe(true);

    const german = searchKnowledge(bundle.entries, 'Konformitätserklärung');
    expect(german.some((entry) => entry.id === 'kbpack-term-term-doc')).toBe(true);
    const synonym = searchKnowledge(bundle.entries, 'Wattage');
    expect(synonym.some((entry) => entry.id === 'kbpack-term-term-power')).toBe(true);
    expect(searchKnowledge(bundle.entries, 'this-query-cannot-match-anything-xyz')).toEqual([]);

    const synthetic: KnowledgeEntry = {
      ...bundle.entries[0],
      id: 'kbpack-fixture-only',
      title: 'ONLY_SYNTHETIC_FIXTURE_MARKER',
      content: 'ONLY_SYNTHETIC_FIXTURE_MARKER',
      metadata: { ...bundle.entries[0].metadata!, synthetic: true },
    };
    expect(searchKnowledge([...bundle.entries, synthetic], 'ONLY_SYNTHETIC_FIXTURE_MARKER')).toEqual([]);
    expect(searchKnowledge([...bundle.entries, synthetic], 'ONLY_SYNTHETIC_FIXTURE_MARKER', 6, { includeSynthetic: true })[0].id).toBe('kbpack-fixture-only');

    const legacy = makeLegacyEntry('legacy-search', 'manual', 'legacy-search-marker');
    expect(searchKnowledge([legacy], 'legacy-search-marker')).toEqual([legacy]);
  });

  it('removes stale managed rule/check entries on a second sync while retaining manual and Obsidian rows', () => {
    const packageDir = clonePackage();
    const db = new AppDatabase({ dbPath: ':memory:' });
    const manual = makeLegacyEntry('manual-retained', 'manual', '人工保留');
    const obsidian = makeLegacyEntry('obsidian-retained', 'obsidian-vault', 'Obsidian 保留');
    db.saveKnowledge(manual);
    db.saveKnowledge(obsidian);

    syncKnowledgePackage(db, packageDir);
    expect(db.listKnowledge().filter((entry) => entry.id.startsWith('kbpack-'))).toHaveLength(54);
    const firstManaged = new Map(db.listKnowledge().filter((entry) => entry.id.startsWith('kbpack-')).map((entry) => [entry.id, entry.updatedAt]));
    syncKnowledgePackage(db, packageDir);
    expect(new Map(db.listKnowledge().filter((entry) => entry.id.startsWith('kbpack-')).map((entry) => [entry.id, entry.updatedAt]))).toEqual(firstManaged);

    const rulesPath = join(packageDir, 'public-rules/rule-cards.jsonl');
    const rules = readFileSync(rulesPath, 'utf8').split(/\r?\n/).filter(Boolean);
    writeFileSync(rulesPath, `${rules.filter((line) => !line.includes('RULE-DOC-IDENTITY-001')).join('\n')}\n`);
    const checklistPath = join(packageDir, 'public-rules/checklist.json');
    const checklist = JSON.parse(readFileSync(checklistPath, 'utf8')) as { items: Array<Record<string, unknown>> };
    checklist.items = checklist.items.filter((item) => item.rule_id !== 'RULE-DOC-IDENTITY-001');
    writeFileSync(checklistPath, JSON.stringify(checklist, null, 2));

    const second = syncKnowledgePackage(db, packageDir);
    expect(second.status.ruleCardCount).toBe(15);
    expect(second.status.checklistCount).toBe(15);
    const current = db.listKnowledge();
    expect(current.filter((entry) => entry.id.startsWith('kbpack-'))).toHaveLength(52);
    expect(current.some((entry) => entry.id === 'kbpack-rule-rule-doc-identity-001')).toBe(false);
    expect(current.some((entry) => entry.id === 'kbpack-check-chk-doc-001')).toBe(false);
    expect(current).toContainEqual(manual);
    expect(current).toContainEqual(obsidian);
    expect(searchKnowledge(current, '跨文件型号身份一致性', 20, { includeSynthetic: true })
      .some((entry) => entry.id === 'kbpack-rule-rule-doc-identity-001' || entry.id === 'kbpack-check-chk-doc-001')).toBe(false);

    db.close();
    rmSync(packageDir, { recursive: true, force: true });
  });

  it('rolls back stale deletion and earlier writes when a SQLite trigger fails mid-sync', () => {
    const packageDir = clonePackage();
    const db = new AppDatabase({ dbPath: ':memory:' });
    syncKnowledgePackage(db, packageDir);
    const before = new Map(db.listKnowledge().map((entry) => [entry.id, entry]));

    const rulesPath = join(packageDir, 'public-rules/rule-cards.jsonl');
    const rules = readFileSync(rulesPath, 'utf8').split(/\r?\n/).filter(Boolean);
    writeFileSync(rulesPath, `${rules.filter((line) => !line.includes('RULE-DOC-IDENTITY-001')).join('\n')}\n`);
    const checklistPath = join(packageDir, 'public-rules/checklist.json');
    const checklist = JSON.parse(readFileSync(checklistPath, 'utf8')) as { items: Array<Record<string, unknown>> };
    checklist.items = checklist.items.filter((item) => item.rule_id !== 'RULE-DOC-IDENTITY-001');
    writeFileSync(checklistPath, JSON.stringify(checklist, null, 2));

    const sourcePath = join(packageDir, 'public-rules/source-index.json');
    const sourceIndex = JSON.parse(readFileSync(sourcePath, 'utf8')) as { sources: Array<Record<string, unknown>> };
    sourceIndex.sources[0].title = 'Trigger failure fixture';
    writeFileSync(sourcePath, JSON.stringify(sourceIndex, null, 2));
    db.sqlite.exec(`
      CREATE TRIGGER fail_knowledge_package_update
      BEFORE UPDATE ON knowledge
      WHEN OLD.id = 'kbpack-source-src-ce-marking'
      BEGIN SELECT RAISE(ABORT, 'forced knowledge sync failure'); END;
    `);

    expect(() => syncKnowledgePackage(db, packageDir)).toThrow(/forced knowledge sync failure/);
    const after = new Map(db.listKnowledge().map((entry) => [entry.id, entry]));
    expect(after).toEqual(before);

    db.close();
    rmSync(packageDir, { recursive: true, force: true });
  });

  it('rejects stable-id slug collisions instead of overwriting compatible kbpack IDs', () => {
    const packageDir = clonePackage();
    const sourcePath = join(packageDir, 'public-rules/source-index.json');
    const sourceIndex = JSON.parse(readFileSync(sourcePath, 'utf8')) as { sources: Array<Record<string, unknown>> };
    const lvd = sourceIndex.sources.find((source) => source.source_id === 'SRC-LVD-2014-35');
    expect(lvd).toBeTruthy();
    sourceIndex.sources.push({ ...lvd, source_id: 'SRC-LVD-2014_35' });
    writeFileSync(sourcePath, JSON.stringify(sourceIndex, null, 2));

    const bundle = loadKnowledgePackage(packageDir);
    expect(bundle.status.available).toBe(false);
    expect(bundle.sources).toEqual([]);
    expect(bundle.entries).toEqual([]);
    expect(bundle.status.warnings.some((warning) => warning.includes('稳定 ID collision'))).toBe(true);

    rmSync(packageDir, { recursive: true, force: true });
  });
});


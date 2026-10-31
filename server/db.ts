import { mkdirSync } from 'node:fs';
import { dirname, isAbsolute, resolve, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type {
  AnalysisResult,
  AuditEvent,
  BootstrapData,
  CaseRecord,
  ChatMessage,
  CostItem,
  EvidenceReport,
  KnowledgeEntry,
  ModelStatus,
  RuleDefinition,
} from '../shared/types.js';
import { normalizeUploadedReportDisplay } from './documents.js';

export interface DatabaseOptions {
  dataDir?: string;
  dbPath?: string;
}

export interface StoredReport {
  report: EvidenceReport;
  sourcePath: string | null;
}

export interface SeedBundle {
  reports?: EvidenceReport[];
  rules?: RuleDefinition[];
  costs?: CostItem[];
  knowledge?: KnowledgeEntry[];
  cases?: CaseRecord[];
}

type Row = Record<string, unknown>;

function now(): string {
  return new Date().toISOString();
}

function json<T>(value: T): string {
  return JSON.stringify(value);
}

function parse<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string') return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function rowData<T>(row: Row | undefined, fallback: T): T {
  return row ? parse(row.data_json, fallback) : fallback;
}

/** Small JSON-column repository. Domain entities remain typed in shared/types.ts. */
export class AppDatabase {
  readonly sqlite: DatabaseSync;
  readonly dataDir: string;
  readonly uploadsDir: string;

  constructor(options: DatabaseOptions = {}) {
    this.dataDir = resolve(options.dataDir ?? process.env.DATA_DIR ?? join(process.cwd(), 'data'));
    this.uploadsDir = join(this.dataDir, 'uploads');
    mkdirSync(this.dataDir, { recursive: true });
    mkdirSync(this.uploadsDir, { recursive: true });

    const dbPath = options.dbPath ?? join(this.dataDir, 'tradetwin.sqlite');
    if (dbPath !== ':memory:') mkdirSync(dirname(resolve(dbPath)), { recursive: true });
    this.sqlite = new DatabaseSync(dbPath);
    this.sqlite.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS cases (
        id TEXT PRIMARY KEY,
        data_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS reports (
        id TEXT PRIMARY KEY,
        data_json TEXT NOT NULL,
        source_path TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS rules (
        id TEXT PRIMARY KEY,
        data_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS costs (
        id TEXT PRIMARY KEY,
        data_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS knowledge (
        id TEXT PRIMARY KEY,
        data_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS audit_events (
        id TEXT PRIMARY KEY,
        case_id TEXT NOT NULL,
        fingerprint TEXT,
        data_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS audit_case_fingerprint
        ON audit_events(case_id, fingerprint) WHERE fingerprint IS NOT NULL;
      CREATE TABLE IF NOT EXISTS request_cache (
        case_id TEXT NOT NULL,
        endpoint TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        response_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY(case_id, endpoint, fingerprint)
      );
      CREATE TABLE IF NOT EXISTS runtime_report_snapshots (
        id TEXT PRIMARY KEY,
        managed_json TEXT NOT NULL
      );
    `);
  }

  close(): void {
    this.sqlite.close();
  }

  seedIfEmpty(bundle: SeedBundle): void {
    const insert = <T extends { id: string }>(table: string, value: T): void => {
      const timestamp = now();
      const statement = this.sqlite.prepare(`
        INSERT OR IGNORE INTO ${table}(id, data_json, updated_at)
        VALUES (?, ?, ?)
      `);
      statement.run(value.id, json(value), timestamp);
    };
    for (const report of bundle.reports ?? []) {
      const existing = this.getReport(report.id);
      if (!existing) {
        this.saveReport(report, null);
      }
    }
    for (const rule of bundle.rules ?? []) insert('rules', rule);
    for (const cost of bundle.costs ?? []) insert('costs', cost);
    for (const entry of bundle.knowledge ?? []) insert('knowledge', entry);
    for (const item of bundle.cases ?? []) {
      if (!this.getCase(item.id)) this.saveCase(item);
    }
  }

  getCase(id: string): CaseRecord | null {
    const row = this.sqlite.prepare('SELECT data_json FROM cases WHERE id = ?').get(id) as Row | undefined;
    return rowData<CaseRecord | null>(row, null);
  }

  listCases(): CaseRecord[] {
    const rows = this.sqlite.prepare('SELECT data_json FROM cases ORDER BY updated_at DESC').all() as Row[];
    return rows.map((row) => rowData<CaseRecord | null>(row, null)).filter((item): item is CaseRecord => !!item);
  }

  saveCase(item: CaseRecord): CaseRecord {
    const timestamp = item.updatedAt || now();
    this.sqlite.prepare(`
      INSERT INTO cases(id, data_json, created_at, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET data_json = excluded.data_json, updated_at = excluded.updated_at
    `).run(item.id, json(item), item.createdAt || timestamp, timestamp);
    return item;
  }

  getReport(id: string): StoredReport | null {
    const row = this.sqlite.prepare('SELECT data_json, source_path FROM reports WHERE id = ?').get(id) as Row | undefined;
    if (!row) return null;
    const report = rowData<EvidenceReport | null>(row, null);
    return report ? { report: normalizeUploadedReportDisplay(report), sourcePath: typeof row.source_path === 'string' ? row.source_path : null } : null;
  }

  listReports(): EvidenceReport[] {
    const rows = this.sqlite.prepare('SELECT data_json FROM reports ORDER BY created_at ASC').all() as Row[];
    return rows.map((row) => {
      const report = rowData<EvidenceReport | null>(row, null);
      return report ? normalizeUploadedReportDisplay(report) : null;
    }).filter((item): item is EvidenceReport => !!item);
  }

  /** Refresh managed demo evidence without overwriting an engineer's edits. */
  syncRuntimeReports(reports: EvidenceReport[]): string[] {
    const conflicts: string[] = [];
    this.sqlite.exec('BEGIN IMMEDIATE');
    try {
      for (const report of reports) {
        const current = this.getReport(report.id);
        const snapshot = this.sqlite.prepare('SELECT managed_json FROM runtime_report_snapshots WHERE id = ?').get(report.id) as { managed_json: string } | undefined;
        const nextJson = json(report);
        const currentJson = current ? json(current.report) : null;
        const canRefresh = !current || currentJson === nextJson || currentJson === snapshot?.managed_json;
        if (canRefresh) {
          if (currentJson !== nextJson || !current?.sourcePath) {
            this.saveReport(report, report.knowledgeSource ? resolve(report.knowledgeSource.path) : null);
          }
          if (snapshot?.managed_json !== nextJson) this.sqlite.prepare('INSERT INTO runtime_report_snapshots(id, managed_json) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET managed_json = excluded.managed_json').run(report.id, nextJson);
        } else if (snapshot && snapshot.managed_json !== nextJson) {
          conflicts.push(report.id);
        }
      }
      this.sqlite.exec('COMMIT');
      return conflicts;
    } catch (error) {
      this.sqlite.exec('ROLLBACK');
      throw error;
    }
  }

  saveReport(report: EvidenceReport, sourcePath: string | null): EvidenceReport {
    const timestamp = now();
    this.sqlite.prepare(`
      INSERT INTO reports(id, data_json, source_path, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET data_json = excluded.data_json,
        source_path = excluded.source_path, updated_at = excluded.updated_at
    `).run(report.id, json(report), sourcePath, report.createdAt || timestamp, timestamp);
    return report;
  }

  updateReport(report: EvidenceReport): EvidenceReport {
    const old = this.getReport(report.id);
    return this.saveReport(report, old?.sourcePath ?? null);
  }

  listRules(): RuleDefinition[] {
    const rows = this.sqlite.prepare('SELECT data_json FROM rules ORDER BY id ASC').all() as Row[];
    return rows.map((row) => rowData<RuleDefinition | null>(row, null)).filter((item): item is RuleDefinition => !!item);
  }

  listCosts(): CostItem[] {
    const rows = this.sqlite.prepare('SELECT data_json FROM costs ORDER BY id ASC').all() as Row[];
    return rows.map((row) => rowData<CostItem | null>(row, null)).filter((item): item is CostItem => !!item);
  }

  listKnowledge(query = ''): KnowledgeEntry[] {
    const rows = this.sqlite.prepare('SELECT data_json FROM knowledge ORDER BY updated_at DESC').all() as Row[];
    const entries = rows.map((row) => rowData<KnowledgeEntry | null>(row, null)).filter((item): item is KnowledgeEntry => !!item);
    const needle = query.trim().toLocaleLowerCase();
    if (!needle) return entries;
    return entries.filter((entry) => `${entry.title}\n${entry.content}\n${entry.tags.join(' ')}`.toLocaleLowerCase().includes(needle));
  }

  saveKnowledge(entry: KnowledgeEntry): KnowledgeEntry {
    const timestamp = entry.updatedAt || now();
    this.sqlite.prepare(`
      INSERT INTO knowledge(id, data_json, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET data_json = excluded.data_json, updated_at = excluded.updated_at
    `).run(entry.id, json(entry), timestamp);
    return entry;
  }

  /**
   * Atomically replace the generated knowledge for one package path.
   *
   * Only kbpack-* rows whose metadata points at packagePath are eligible for
   * removal. Manual and Obsidian rows are never deleted or overwritten, even
   * if a caller supplies a colliding generated id.
   */
  syncManagedKnowledge(packagePath: string, entries: KnowledgeEntry[]): void {
    const managedEntries = entries.filter((entry) => (
      entry.id.startsWith('kbpack-') && entry.metadata?.packagePath === packagePath
    ));
    const incomingIds = new Set(managedEntries.map((entry) => entry.id));
    let transactionStarted = false;
    try {
      this.sqlite.exec('BEGIN IMMEDIATE');
      transactionStarted = true;
      const rows = this.sqlite.prepare('SELECT id, data_json FROM knowledge WHERE id LIKE ?').all('kbpack-%') as Row[];
      const current = rows
        .map((row) => ({ id: typeof row.id === 'string' ? row.id : '', entry: rowData<KnowledgeEntry | null>(row, null) }))
        .filter((row): row is { id: string; entry: KnowledgeEntry } => !!row.id && !!row.entry);

      const isProtected = (source: string): boolean => {
        const normalized = source.toLocaleLowerCase();
        return normalized === 'manual' || normalized.includes('obsidian');
      };
      const remove = this.sqlite.prepare('DELETE FROM knowledge WHERE id = ?');
      for (const row of current) {
        if (
          row.entry.metadata?.packagePath === packagePath
          && row.id.startsWith('kbpack-')
          && !incomingIds.has(row.id)
          && !isProtected(row.entry.source)
        ) {
          remove.run(row.id);
        }
      }

      const upsert = this.sqlite.prepare(`
        INSERT INTO knowledge(id, data_json, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET data_json = excluded.data_json, updated_at = excluded.updated_at
      `);
      for (const entry of managedEntries) {
        const currentEntry = current.find((row) => row.id === entry.id)?.entry;
        if (currentEntry && isProtected(currentEntry.source)) continue;
        const timestamp = entry.updatedAt || now();
        upsert.run(entry.id, json(entry), timestamp);
      }
      this.sqlite.exec('COMMIT');
      transactionStarted = false;
    } catch (error) {
      if (transactionStarted) {
        try {
          this.sqlite.exec('ROLLBACK');
        } catch {
          // Preserve the original database error.
        }
      }
      throw error;
    }
  }

  addAudit(event: AuditEvent): AuditEvent {
    const existing = event.fingerprint
      ? this.sqlite.prepare('SELECT data_json FROM audit_events WHERE case_id = ? AND fingerprint = ?').get(event.caseId, event.fingerprint) as Row | undefined
      : undefined;
    if (existing) return rowData<AuditEvent>(existing, event);
    this.sqlite.prepare(`
      INSERT OR IGNORE INTO audit_events(id, case_id, fingerprint, data_json, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(event.id, event.caseId, event.fingerprint ?? null, json(event), event.createdAt || now());
    const stored = this.sqlite.prepare('SELECT data_json FROM audit_events WHERE id = ?').get(event.id) as Row | undefined;
    return rowData<AuditEvent>(stored, event);
  }

  listAudit(caseId?: string): AuditEvent[] {
    const rows = caseId
      ? this.sqlite.prepare('SELECT data_json FROM audit_events WHERE case_id = ? ORDER BY created_at ASC').all(caseId)
      : this.sqlite.prepare('SELECT data_json FROM audit_events ORDER BY created_at ASC').all();
    return (rows as Row[]).map((row) => rowData<AuditEvent | null>(row, null)).filter((item): item is AuditEvent => !!item);
  }

  getCachedRequest(caseId: string, endpoint: string, fingerprint: string): unknown | null {
    const row = this.sqlite.prepare(`
      SELECT response_json FROM request_cache WHERE case_id = ? AND endpoint = ? AND fingerprint = ?
    `).get(caseId, endpoint, fingerprint) as Row | undefined;
    return row ? parse<unknown | null>(row.response_json, null) : null;
  }

  cacheRequest(caseId: string, endpoint: string, fingerprint: string, response: unknown): void {
    this.sqlite.prepare(`
      INSERT OR IGNORE INTO request_cache(case_id, endpoint, fingerprint, response_json, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(caseId, endpoint, fingerprint, json(response), now());
  }

  bootstrap(model: ModelStatus, ruleVersion: string): BootstrapData {
    return {
      cases: this.listCases(),
      reports: this.listReports(),
      rules: this.listRules(),
      knowledge: this.listKnowledge(),
      costs: this.listCosts(),
      model,
      ruleVersion,
    };
  }
}

export function resolveStoredPath(dataDir: string, sourcePath: string): string {
  return isAbsolute(sourcePath) ? sourcePath : resolve(dataDir, sourcePath);
}

export function createdAt(): string {
  return now();
}


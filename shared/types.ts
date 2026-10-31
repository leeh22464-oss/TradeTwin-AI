export type Channel = 'email' | 'rfq';
export type FindingStatus = 'retest' | 'reuse' | 'update' | 'review' | 'warning';
export interface ProductConfig {
  model: string; powerW: number | null; ip: string | null; driver: string | null;
  material: string | null; market: string | null;
}
export interface EvidencePage { page: number; text: string }
export interface Coverage {
  series: string | null; powerMinW: number | null; powerMaxW: number | null;
  ipLevels: string[]; drivers: string[]; materials: string[]; markets: string[];
  tests: string[]; confidence: number;
}
export interface EvidenceReport {
  id: string; title: string; kind: 'safety' | 'emc' | 'rohs' | 'spec' | 'doc' | 'label' | 'manual' | 'other';
  source: 'synthetic' | 'uploaded'; status: 'ready' | 'needs_review' | 'failed';
  filename: string; filenameEncoding?: 'utf-8'; pageCount: number; pages: EvidencePage[]; coverage: Coverage;
  verified: boolean; notes: string; createdAt: string;
  testScopes?: Record<string, { coverage: Coverage; page: number; quote?: string }>;
}
export interface EvidenceRef { reportId: string; page: number; quote: string }
export interface Finding {
  id: string; itemId: string; title: string; category: 'compliance' | 'documents' | 'contract';
  status: FindingStatus; reason: string; ruleIds: string[]; evidence: EvidenceRef[];
  feeEur: number | null; days: number | null;
}
export interface RuleDefinition { id: string; title: string; description: string; category: string; version: string }
export interface CostItem { id: string; title: string; feeEur: number; days: number; group: 'test' | 'document' }
export interface Alternative {
  id: 'A' | 'B'; label: string; config: ProductConfig; totalCostEur: number;
  leadTimeDays: number | null; requiredTests: string[]; summary: string;
}
export interface AnalysisResult {
  id: string; ruleVersion: string; config: ProductConfig; findings: Finding[];
  requiredTests: string[]; reusedTests: string[]; documentUpdates: string[];
  reviewCount: number; totalCostEur: number; leadTimeDays: number | null;
  canQuote: boolean; confidence: number; warnings: string[]; alternatives: Alternative[];
  calculation: { parallelDays: number; documentationDays: number; formula: string };
}
export interface QuoteResult {
  id: string; channel: Channel; en: string; de: string;
  internal: { sales: string[]; quality: string[]; procurement: string[] };
  modelMode: 'demo' | 'live' | 'fallback'; modelName: string; warnings: string[]; generatedAt: string;
}
export interface ChatMessage { id: string; role: 'user' | 'assistant'; content: string; createdAt: string; mode?: string }
export interface CaseRecord {
  id: string; name: string; buyer: string; createdAt: string; updatedAt: string; round: number;
  baseConfig: ProductConfig; requestedConfig: ProductConfig; quantity: number; unitPriceEur: number;
  channel: Channel; inquiry: string; commitment: string;
  analysis: AnalysisResult | null; quote: QuoteResult | null; messages: ChatMessage[];
}
export interface KnowledgeEntry {
  id: string; title: string; content: string; tags: string[]; source: string; updatedAt: string;
  metadata?: KnowledgeMetadata;
}
export interface KnowledgeMetadata {
  kind: 'public_source' | 'checklist' | 'glossary' | 'guidance';
  packageVersion: string; packagePath: string;
  sourceId?: string; sourceUrl?: string; publisher?: string; asOf?: string;
  humanReviewRequired: boolean; synthetic: boolean;
}
export interface KnowledgeSource {
  sourceId: string; title: string; url: string; identifier: string;
  publisher: string; topic: string; scopeNote: string; asOf: string;
  humanReviewRequired: boolean;
}
export interface KnowledgePackageStatus {
  available: boolean; packageName: string; packageVersion: string; indexVersion: string;
  retrievedOn: string; sourceCount: number; ruleCardCount: number; checklistCount: number; glossaryCount: number;
  importedCount: number; warnings: string[];
}
export interface KnowledgeIndex {
  package: KnowledgePackageStatus; sources: KnowledgeSource[];
  research: { configured: boolean; enabled: boolean; provider: 'openai'; model: string; message: string };
}
export interface ResearchCitation {
  url: string; title: string; startIndex: number; endIndex: number; sourceId?: string;
}
export interface ResearchResult {
  id: string; query: string; answer: string; mode: 'local' | 'live' | 'fallback';
  modelName: string; webSearchPerformed: boolean; checkedAt: string | null;
  localEntries: KnowledgeEntry[]; indexedSources: KnowledgeSource[];
  citations: ResearchCitation[]; consultedSources: Array<{ url: string; title: string }>;
  warnings: string[];
}
export interface AuditEvent {
  id: string; caseId: string; type: string; actor: string; detail: string;
  createdAt: string; ruleVersion: string; fingerprint?: string;
}
export interface ModelStatus {
  configured: boolean; mode: 'demo' | 'live'; model: string; baseUrl: string;
  lastError?: string; vaultConfigured: boolean;
}
export interface BootstrapData {
  cases: CaseRecord[]; reports: EvidenceReport[]; rules: RuleDefinition[];
  knowledge: KnowledgeEntry[]; costs: CostItem[]; model: ModelStatus; ruleVersion: string;
}

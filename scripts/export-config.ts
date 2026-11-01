import { writeFile } from 'node:fs/promises';
import { seedKnowledge } from '../server/seed';
import { loadRuntimeKnowledge } from '../server/runtimeKnowledge';

const runtime = loadRuntimeKnowledge();
if (!runtime.available) throw new Error(runtime.warnings.join('; '));

const config = {
  product: 'TradeTwin AI',
  schemaVersion: 2,
  ruleVersion: runtime.context.version,
  mode: 'synthetic-demonstration',
  scope: 'EU/DE indoor fixed LED luminaires; expert confirmation required',
  baseConfig: runtime.baseConfig,
  schedule: { policy: 'serial-preparation-parallel-tests-serial-documents', expression: 'driver preparation days + max(required test days) + document update days' },
  model: {
    protocol: 'Official OpenAI Responses; optional legacy OpenAI-compatible Chat Completions',
    environmentKeys: ['OPENAI_API_KEY', 'OPENAI_MODEL', 'LLM_BASE_URL', 'LLM_API_KEY', 'LLM_MODEL'],
    secretsIncluded: false,
    responsibilities: ['structured change extraction', 'bounded bilingual business introduction'],
    deterministic: ['evidence coverage', 'minimum retests', 'fees', 'schedule', 'quote facts', 'Chinese role tasks'],
  },
  knowledge: { storage: 'SQLite and local Markdown', optionalVaultKey: 'OBSIDIAN_VAULT_PATH', runtime: runtime.context, seedEntriesOnly: seedKnowledge },
  policy: runtime.policy,
  rules: runtime.rules,
  costs: runtime.costs,
  reports: runtime.reports,
};
await writeFile('docs/平台配置导出.json', `${JSON.stringify(config, null, 2)}\n`);
console.log(`Exported ${runtime.rules.length} source rules, ${runtime.costs.length} cost rows and ${runtime.reports.length} knowledge-backed synthetic reports without secrets.`);

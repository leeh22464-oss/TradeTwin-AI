import { writeFile } from 'node:fs/promises';
import { BASE_CONFIG, RULE_VERSION, seedCosts, seedKnowledge, seedReports, seedRules } from '../server/seed';

const config = {
  product: 'TradeTwin AI',
  schemaVersion: 1,
  ruleVersion: RULE_VERSION,
  mode: 'synthetic-demonstration',
  scope: 'EU/DE indoor fixed LED luminaires; expert confirmation required',
  baseConfig: BASE_CONFIG,
  schedule: { policy: 'parallel-tests-then-documents', expression: 'max(required test days) + document update days' },
  model: {
    protocol: 'OpenAI-compatible Chat Completions',
    environmentKeys: ['LLM_BASE_URL', 'LLM_API_KEY', 'LLM_MODEL'],
    secretsIncluded: false,
    responsibilities: ['structured change extraction', 'bounded bilingual business introduction'],
    deterministic: ['evidence coverage', 'minimum retests', 'fees', 'schedule', 'quote facts', 'Chinese role tasks'],
  },
  knowledge: { storage: 'SQLite and local Markdown', optionalVaultKey: 'OBSIDIAN_VAULT_PATH', entries: seedKnowledge },
  rules: seedRules,
  costs: seedCosts,
  reports: seedReports,
};
await writeFile('docs/平台配置导出.json', `${JSON.stringify(config, null, 2)}\n`);
console.log(`Exported ${seedRules.length} rules, ${seedCosts.length} cost rows and ${seedReports.length} synthetic reports without secrets.`);

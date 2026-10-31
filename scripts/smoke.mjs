import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';

const base = process.env.TRADETWIN_API_URL || 'http://127.0.0.1:3001';
const headers = { 'content-type': 'application/json' };
async function call(path, method = 'GET', body) {
  const response = await fetch(`${base}${path}`, { method, headers, ...(body ? { body: JSON.stringify(body) } : {}) });
  const data = await response.json();
  assert.ok(response.ok, `${method} ${path}: ${response.status} ${JSON.stringify(data)}`);
  return data;
}

assert.equal((await call('/api/health')).ok, true);
const item = await call('/api/cases', 'POST', {
  name: '自动验收 · 德国灯具变更', buyer: '合成演示客户', quantity: 500, unitPriceEur: 18.5,
  inquiry: 'Bitte 36 Watt statt 24 Watt, IP44; der Treiber bleibt DRV-A.',
});
assert.equal(item.requestedConfig.powerW, 36);
const path = `/api/cases/${item.id}`;
const first = await call(`${path}/analyze`, 'POST', {});
assert.equal(first.analysis.totalCostEur, 2100);
assert.equal(first.analysis.calculation.estimatedDays, 8);
assert.equal(first.analysis.leadTimeDays, null);
assert.equal(first.analysis.canQuote, false);
assert.equal(first.analysis.findings.find((f) => f.itemId === 'emc').status, 'review');
assert.ok(first.analysis.requiredTests.includes('temperature') && first.analysis.requiredTests.includes('ip'));
assert.ok(first.analysis.knowledgeContext?.fingerprint);
const repeated = await call(`${path}/analyze`, 'POST', {});
assert.equal(repeated.analysis.id, first.analysis.id);
let result = await call(`${path}/quote`, 'POST', { channel: 'email' });
assert.ok(result.quote.en.length > 80 && result.quote.de.length > 80);
assert.ok(result.quote.internal.quality.some((text) => /[\u4e00-\u9fff]/.test(text)));
result = await call(`${path}/chat`, 'POST', { message: '客户选择方案 A，改成 30W / IP44，请重新计算。', channel: 'rfq' });
assert.equal(result.requestedConfig.powerW, 30);
assert.equal(result.analysis.totalCostEur, 900);
assert.equal(result.analysis.calculation.estimatedDays, 7);
assert.equal(result.analysis.leadTimeDays, null);
assert.deepEqual(result.analysis.requiredTests, ['ip']);
result = await call(`${path}/chat`, 'POST', { message: '暂不承诺具体交期，等实验室排期确认。' });
assert.match(result.commitment, /不承诺/);
assert.match(result.quote.en, /no specific|not commit|confirmed|scheduling/i);
assert.equal(result.analysis.totalCostEur, 900);
const reopened = await call(path);
assert.equal(reopened.round, result.round);
assert.equal(reopened.messages.length, result.messages.length);
const events = await call(`/api/audit?caseId=${encodeURIComponent(item.id)}`);
assert.ok(events.some((event) => event.type === 'analysis.completed'));
assert.ok(events.filter((event) => event.type === 'chat.completed').length >= 2);
const exported = await fetch(`${base}${path}/export`);
assert.equal(exported.status, 200);
const markdown = await exported.text();
assert.ok(markdown.includes('900') && markdown.includes('证据'));
await mkdir('test-results', { recursive: true });
await writeFile('test-results/smoke-case.md', markdown);
await writeFile('test-results/smoke.json', JSON.stringify({
  checkedAt: new Date().toISOString(), caseId: item.id, modelMode: result.quote.modelMode,
  first: { knownCost: first.analysis.totalCostEur, planningDays: first.analysis.calculation.estimatedDays, committedDays: first.analysis.leadTimeDays },
  second: { knownCost: result.analysis.totalCostEur, planningDays: result.analysis.calculation.estimatedDays, committedDays: result.analysis.leadTimeDays },
  messages: result.messages.length, auditEvents: events.length,
}, null, 2));
console.log(`PASS: known €2,100 / estimated 8 days → known €900 / estimated 7 days; EMC pending, no delivery commitment; ${result.messages.length} messages; ${events.length} audit events.`);
console.log(`Case: ${item.id}; model mode: ${result.quote.modelMode}; export: test-results/smoke-case.md`);

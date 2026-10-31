import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

dotenv.config({ path: fileURLToPath(new URL('../.env', import.meta.url)), quiet: true });
const base = (process.env.TRADETWIN_API_URL || `http://127.0.0.1:${process.env.PORT || 3001}`).replace(/\/$/, '');

async function json(path, body) {
  let response;
  try {
    response = await fetch(`${base}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(90_000),
    });
  } catch {
    throw new Error(`Node API unavailable at ${base}. Start both services with npm run dev or npm start.`);
  }
  assert.ok(response.ok, `${path} returned HTTP ${response.status}; check the service logs.`);
  return response.json();
}

function versions(result, envelope) {
  assert.equal(result.workflow2.ok, true, 'Workflow two must complete through real HTTP');
  assert.match(result.workflow2.provider, /^http:/, 'Local reference mode does not exercise the integration');
  assert.equal(result.workflow2.rule_version, envelope.rule_version);
  assert.equal(result.workflow2.evidence_version, envelope.evidence_version);
  assert.equal(result.scope.rule_version, envelope.rule_version);
  assert.equal(result.scope.evidence_version, envelope.evidence_version);
  assert.ok(result.scope.pricing_version, 'Pricing source version is required');
  for (const option of result.quote_options) {
    assert.equal(option.assumption_version, envelope.assumption_version);
    assert.equal(option.synthetic, true);
    assert.equal(option.human_confirmed, false);
    assert.ok(option.source_type, 'The quote must retain its source type');
  }
}

async function main() {
  assert.equal((await json('/api/health')).ok, true);
  const health = await json('/api/workflow1/health');
  assert.equal(health.workflow2.ok, true, 'Python must reach the managed Node workflow two API');
  assert.match(health.workflow2.provider, /^http:/);
  const envelope = await json('/api/workflow2/envelope');
  assert.ok(envelope.rule_version && envelope.evidence_version);

  const first = await json('/api/workflow1/analyze', {
    text: 'Please change the luminaire to 36W and IP44. Keep DRV-A. 100 pcs.',
    channel: 'email', source: 'workflow-smoke', languages: ['en', 'de'],
  });
  versions(first, envelope);
  const requested = first.quote_options.find((option) => option.kind === 'requested');
  assert.ok(requested, 'The requested configuration must be quoted');
  assert.equal(requested.estimated_cost_eur, 2100);
  assert.equal(requested.estimated_days, 8);
  const withinCoverage = first.quote_options.find((option) => option.kind === 'within_coverage');
  assert.ok(withinCoverage, 'Find the coverage option by kind; its letter is not fixed');
  const initialSync = await json('/api/workflow1/sync', first);
  assert.equal(initialSync.case.workflow1LastRunId, first.run_id);
  assert.equal(initialSync.case.workflow1QuoteReady, true);

  const second = await json('/api/workflow1/instruct', {
    session_id: first.session_id,
    instruction: `选择方案 ${withinCoverage.option_id}，暂不承诺具体交期，等实验室排期确认。`,
  });
  versions(second, envelope);
  assert.equal(second.selected_option_id, withinCoverage.option_id);
  assert.equal(second.quote_options[0].config.power_w, 30);
  assert.equal(second.quote_options[0].config.ip_rating, 'IP44');
  assert.equal(second.quote_options[0].estimated_cost_eur, 900);
  assert.equal(second.quote_options[0].estimated_days, 7);
  assert.equal(second.constraints.hide_delivery_date, true);
  for (const language of ['en', 'de']) {
    assert.ok(second.replies[language]?.body, `${language} reply must be generated`);
    assert.doesNotMatch(second.replies[language].body, /working days|Arbeitstage/i);
  }
  const latest = await json('/api/workflow1/sync', second);
  assert.equal(latest.case.workflow1LastRunId, second.run_id);
  assert.equal(latest.case.workflow1QuoteReady, true);
  assert.equal(latest.case.requestedConfig.powerW, 30);
  assert.equal(latest.case.analysis.totalCostEur, 900);
  assert.equal(latest.case.analysis.leadTimeDays, 7);
  assert.equal(latest.case.workflow1Result.scope.evidence_version, envelope.evidence_version);
  const auditPath = `/api/audit?caseId=${encodeURIComponent(first.session_id)}`;
  const eventsBefore = await json(auditPath);

  // Replay every earlier round after the latest one, including its original
  // generated timestamp. A replay must never roll the shared case backward.
  for (const previous of [first, second, first]) {
    const replay = await json('/api/workflow1/sync', previous);
    assert.equal(replay.replay, true, `Round ${previous.round} must be idempotent`);
    assert.equal(replay.case.workflow1LastRunId, second.run_id);
    assert.equal(replay.case.round, latest.case.round);
    assert.equal(replay.case.requestedConfig.powerW, 30);
  }
  const eventsAfter = await json(auditPath);
  assert.equal(eventsAfter.length, eventsBefore.length, 'Historical sync replays must not create audit events');
  const reopened = await json(`/api/cases/${encodeURIComponent(first.session_id)}`);
  assert.equal(reopened.workflow1LastRunId, second.run_id);
  assert.equal(reopened.workflow1Result.constraints.hide_delivery_date, true);
  assert.equal(reopened.workflow1QuoteReady, true);

  // Natural-language scope confirmations must survive Python extraction and
  // Node synchronization with the same canonical supported configuration.
  const baseline = await json('/api/workflow1/analyze', {
    text: 'Please quote 36W IP44 with the same DRV-A driver, same original material / Germany',
    channel: 'email', source: 'workflow-smoke', languages: ['en', 'de'],
  });
  versions(baseline, envelope);
  assert.ok(baseline.quote_options.length);
  const baselineSync = await json('/api/workflow1/sync', baseline);

  const unsupported = await json('/api/workflow1/analyze', {
    text: 'Please quote 36W IP44 with the same DRV-A driver; material PVC; target market US',
    channel: 'email', source: 'workflow-smoke', languages: ['en', 'de'],
  });
  assert.equal(unsupported.mode, 'pending_check');
  assert.deepEqual(unsupported.quote_options, []);
  const unsupportedSync = await json('/api/workflow1/sync', unsupported);
  assert.equal(unsupportedSync.case.workflow1QuoteReady, false);
  assert.equal(unsupportedSync.case.requestedConfig.material, 'PVC');
  assert.equal(unsupportedSync.case.requestedConfig.market, 'US');
  const materialReturned = await json('/api/workflow1/instruct', {
    session_id: unsupported.session_id, instruction: 'Use the original material again.',
  });
  assert.equal(materialReturned.mode, 'pending_check');
  assert.deepEqual(materialReturned.quote_options, []);
  const materialSync = await json('/api/workflow1/sync', materialReturned);
  assert.equal(materialSync.case.workflow1QuoteReady, false, 'US market must keep the case pending');
  assert.equal(materialSync.case.requestedConfig.market, 'US');
  const returned = await json('/api/workflow1/instruct', {
    session_id: unsupported.session_id, instruction: 'Return to the Germany market only.',
  });
  versions(returned, envelope);
  assert.ok(returned.quote_options.length);
  const returnedSync = await json('/api/workflow1/sync', returned);
  assert.deepEqual([baselineSync.case.workflow1QuoteReady, returnedSync.case.workflow1QuoteReady],
    [true, true], 'Initial baseline wording and explicit PVC/US return must both be ready after Node sync');
  for (const result of [baseline, materialReturned, returned]) {
    assert.equal(result.scope.requested_material, 'original-material');
    const row = result.change_order.find((row) => row.field === 'material');
    assert.equal(row.to, 'original-material');
    assert.match(row.source_quote, /original material/);
  }
  for (const synced of [baselineSync, returnedSync]) {
    assert.equal(synced.case.requestedConfig.material, 'original-material');
    assert.equal(synced.case.requestedConfig.market, 'DE');
    const saved = await json(`/api/cases/${encodeURIComponent(synced.case.id)}`);
    assert.equal(saved.workflow1QuoteReady, true);
  }
  console.log('PASS: Node → Python → Node HTTP; €2,100 / 8 days → €900 / 7 days; delivery hidden; historical sync replay and source versions preserved.');
  console.log('PASS: Initial original-material/Germany and PVC/US → explicit baseline return are ready after sync; partial return stays pending.');
  console.log(`Synthetic smoke case: ${first.session_id}`);
}

main().catch((error) => {
  console.error(`Workflow smoke failed: ${error.message}`);
  process.exitCode = 1;
});

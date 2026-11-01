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
  assert.equal(first.mode, 'pending_check');
  assert.equal(first.status, 'NEEDS_MANUAL_REVIEW');
  assert.deepEqual(first.quote_options, [], 'Unreviewed evidence must not be presented as a quote');
  assert.deepEqual(first.candidate_options.map((option) => option.config.power_w), [36, 30]);
  assert.ok(first.coverage_findings.some((finding) => finding.item_key === 'emc_electrical' && finding.status === 'MANUAL_REVIEW'));
  assert.ok(first.coverage_findings.some((finding) => finding.item_key === 'thermal_rise' && finding.status === 'NEEDS_RETEST'));
  assert.ok(first.coverage_findings.some((finding) => finding.item_key === 'ingress_protection' && finding.status === 'NEEDS_RETEST'));
  const initialSync = await json('/api/workflow1/sync', first);
  assert.equal(initialSync.case.workflow1LastRunId, first.run_id);
  assert.equal(initialSync.case.workflow1QuoteReady, false);
  assert.equal(initialSync.case.requestedConfig.powerW, 36);

  const second = await json('/api/workflow1/instruct', {
    session_id: first.session_id,
    instruction: '改成 30W / IP44；暂不承诺具体交期，等实验室和 EMC 复核确认。',
  });
  versions(second, envelope);
  assert.equal(second.mode, 'pending_check');
  assert.deepEqual(second.quote_options, []);
  assert.equal(second.selected_option_id, null);
  assert.equal(second.change_order.find((row) => row.field === 'power_w').to, 30);
  assert.equal(second.change_order.find((row) => row.field === 'ip_rating').to, 'IP44');
  assert.ok(second.coverage_findings.some((finding) => finding.item_key === 'emc_electrical' && finding.status === 'MANUAL_REVIEW'));
  const latest = await json('/api/workflow1/sync', second);
  assert.equal(latest.case.workflow1LastRunId, second.run_id);
  assert.equal(latest.case.workflow1QuoteReady, false);
  assert.equal(latest.case.requestedConfig.powerW, 30);
  assert.equal(latest.case.analysis.totalCostEur, 900);
  assert.equal(latest.case.analysis.leadTimeDays, null);
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
  assert.equal(reopened.workflow1QuoteReady, false);
  console.log('PASS: Node → Python → Node HTTP; 36W/IP44 → 30W/IP44; EMC remains manual review, no premature quote or delivery promise; historical sync replay and source versions preserved.');
  console.log(`Synthetic smoke case: ${first.session_id}`);
}

main().catch((error) => {
  console.error(`Workflow smoke failed: ${error.message}`);
  process.exitCode = 1;
});

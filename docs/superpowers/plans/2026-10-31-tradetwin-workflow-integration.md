# TradeTwin AI Dual-Workflow Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete the local `integration/` application so workflow one owns inquiry understanding and buyer replies while workflow two remains the only source of evidence coverage, retest cost, and schedule.

**Architecture:** Keep the existing Python/FastAPI workflow one and Node/Express workflow two as separate local services. Route the sales workspace and browser extension through the Node origin, connect the services with `tradetwin.wf2.v1`, and synchronize each workflow-one run into one Node case with strict validation and audit history.

**Tech Stack:** React 19, TypeScript 5.9, Vite 7, Express 5, Node.js 24 SQLite, Python 3.11+, FastAPI, httpx, pytest, Chrome/Edge Manifest V3.

**Spec:** `docs/superpowers/specs/2026-10-31-tradetwin-workflow-integration-design.md`

## Global Constraints

- The implementation target is the existing untracked `integration/` snapshot; do not delete or overwrite the root `app/`, `extension/`, or architecture artifacts.
- Workflow one owns source extraction, change orders, option configuration, bilingual drafts, questions, and reply checking.
- Workflow two owns evidence coverage, retest decisions, test cost, schedule, rule version, and evidence version.
- Unknown parameters, missing/unverified evidence, malformed contracts, and unavailable services produce questions/manual review, never a definite price or schedule.
- Email is IMAP read-only and draft-only. The application must not expose an SMTP send action.
- The extension may read selected text or a visible recent buyer message and may fill a trusted reply editor, but it must never submit the message.
- All product, buyer, report, cost, and timing fixtures remain visibly labelled synthetic demonstration data.
- No external push, release, or production deployment is part of this plan.

## File Map

- `integration/server/workflow2.ts`: Node adapter from the live evidence database to `tradetwin.wf2.v1`.
- `integration/workflow-1/app/tradetwin/workflow2.py`: strict Python client and response normalizer for that contract.
- `integration/workflow-1/app/tradetwin/pipeline.py`: multi-turn workflow-one orchestration and evidence-aware idempotency.
- `integration/workflow-1/app/tradetwin/mailbox.py`: IMAP PEEK fetch, stable thread grouping, and draft construction.
- `integration/workflow-1/app/tradetwin/server.py`: workflow-one HTTP API; draft-only email surface.
- `integration/workflow-1/extension/content.js`: page text acquisition and trusted editor insertion.
- `integration/workflow-1/extension/sidepanel.js`: extension session identity, visible source text, and Node-proxied API calls.
- `integration/server/workflow1.ts`: same-origin proxy plus validated workflow-one-to-case synchronization.
- `integration/src/components/SalesWorkspace.tsx`: main-app sales workspace handoff and recoverable health state.
- `integration/scripts/workflows.mjs`: starts/stops Node, Vite, and Python together.
- `integration/scripts/smoke-workflows.mjs`: exercises the real two-service HTTP loop.

---

### Task 1: Lock the Workflow Contract and Evidence-Aware Replay

**Files:**
- Modify: `integration/workflow-1/app/tests/fake_wf2.py`
- Modify: `integration/workflow-1/app/tests/test_integration.py`
- Modify: `integration/workflow-1/app/tradetwin/workflow2.py`
- Modify: `integration/workflow-1/app/tradetwin/pipeline.py`
- Modify: `integration/workflow-1/app/.env.example`

**Interfaces:**
- Consumes: `GET /api/workflow2/envelope` and `POST /api/workflow2/evaluate` from Node.
- Produces: `workflow2.envelope() -> dict`, `workflow2.evaluate(configs: dict[str, dict]) -> dict`, and cache keys containing the current `evidence_version`.

- [ ] **Step 1: Add a failing evidence-change replay test**

Extend `fake_wf2.BEHAVIOUR` with `evidence_version`, return it from both `envelope()` and `evaluate()`, then add:

```python
def test_evidence_change_forces_a_new_workflow2_run(teammate):
    teammate["evidence_version"] = "evidence-v1"
    first = pipeline.analyze_message(DE_RFQ, session_id="evidence-refresh")
    replay = pipeline.analyze_message(DE_RFQ, session_id="evidence-refresh")
    assert replay["idempotent_replay"] is True

    teammate["evidence_version"] = "evidence-v2"
    refreshed = pipeline.analyze_message(DE_RFQ, session_id="evidence-refresh")
    assert refreshed["idempotent_replay"] is False
    assert refreshed["run_id"] != first["run_id"]
    assert refreshed["scope"]["evidence_version"] == "evidence-v2"
```

- [ ] **Step 2: Run the focused test and confirm the old result is replayed**

Run: `python -m pytest -q tests/test_integration.py::test_evidence_change_forces_a_new_workflow2_run`

Expected before any fix: FAIL because the second evidence version is not consistently propagated or the old run is reused.

- [ ] **Step 3: Keep envelope uncached and validate response correlation**

Ensure `workflow2.envelope()` calls `_call("envelope")` every time. Keep `evaluate()` checks for exact `contract_version`, exact `request_id`, a one-to-one `config_id` set, finite non-negative estimates or `None`, positive evidence pages, and non-empty evidence quotes. Do not introduce a time-based envelope cache.

Set the integrated example to the Node source of truth:

```dotenv
WORKFLOW2_MODE=http
WORKFLOW2_URL=http://127.0.0.1:3001/api/workflow2
WORKFLOW2_TIMEOUT=15
```

Keep `WORKFLOW2_MODE=local` documented only as an explicitly selected offline reference mode.

- [ ] **Step 4: Run all workflow-one contract tests**

Run: `python -m pytest -q tests/test_workflow2.py tests/test_integration.py`

Expected: all tests pass, including request-ID mismatch, null estimates, explicit parameter override, evidence refresh, and hidden delivery date.

- [ ] **Step 5: Commit the contract hardening**

```powershell
git add -- integration/workflow-1/app/.env.example integration/workflow-1/app/tradetwin/workflow2.py integration/workflow-1/app/tradetwin/pipeline.py integration/workflow-1/app/tests/fake_wf2.py integration/workflow-1/app/tests/test_integration.py
git commit -m "fix: refresh quotes when workflow evidence changes"
```

---

### Task 2: Make Email Intake Stable, Read-Only, and Draft-Only

**Files:**
- Create: `integration/workflow-1/app/tests/test_mailbox.py`
- Modify: `integration/workflow-1/app/tradetwin/mailbox.py`
- Modify: `integration/workflow-1/app/tradetwin/server.py`
- Modify: `integration/workflow-1/app/tradetwin/static/index.html`
- Modify: `integration/workflow-1/app/tradetwin/static/app.js`
- Modify: `integration/workflow-1/app/tests/test_settings.py`

**Interfaces:**
- Consumes: raw RFC 5322 messages and an IMAP connection.
- Produces: stable `thread_id`, deduplicated messages, `build_reply(...)` with `In-Reply-To`/`References`, and `POST /api/mail/draft`; no send endpoint.

- [ ] **Step 1: Add failing thread and PEEK tests**

Create helpers that build raw messages with controlled From/To/Message-ID headers, then add tests for these exact behaviors:

```python
def test_missing_message_id_is_stable_for_the_same_raw_message():
    raw = make_mail(message_id=None, sender="buyer@example.com", recipient="sales@example.com")
    assert mailbox.parse_message(raw)["message_id"] == mailbox.parse_message(raw)["message_id"]

def test_same_subject_from_two_buyers_does_not_merge():
    mails = [
        mailbox.parse_message(make_mail(message_id="<a@x>", sender="a@example.com", subject="RFQ")),
        mailbox.parse_message(make_mail(message_id="<b@x>", sender="b@example.com", subject="RFQ")),
    ]
    assert len(mailbox.group_threads(mails, "sales@example.com")) == 2

def test_reply_headers_keep_the_original_thread():
    thread = next(iter(mailbox.group_threads([mailbox.parse_message(make_mail(
        message_id="<buyer-1@example.com>", sender="buyer@example.com",
        references=["<root@example.com>"]))], "sales@example.com").values()))
    reply = mailbox.build_reply(thread, "Re: RFQ", "Draft")
    assert reply["In-Reply-To"] == "<buyer-1@example.com>"
    assert reply["References"] == "<root@example.com> <buyer-1@example.com>"
```

Use a fake IMAP object to assert `select("INBOX", readonly=True)` and `fetch(num, "(BODY.PEEK[])")` are called, and that no `STORE` command is issued.

- [ ] **Step 2: Run the mailbox tests and verify the generated-ID test fails**

Run: `python -m pytest -q tests/test_mailbox.py`

Expected: FAIL because `parse_message()` currently uses random `make_msgid()` when the source message has no Message-ID.

- [ ] **Step 3: Implement deterministic identity and participant-aware fallback grouping**

In `parse_message(raw)`, derive the fallback identity from the immutable raw bytes:

```python
source_id = str(msg["message-id"] or "").strip()
message_id = source_id or f"<tradetwin-{hashlib.sha256(raw).hexdigest()[:24]}@local>"
```

Parse `To`/`Cc` addresses. In `group_threads`, derive the counterpart as the inbound sender or the outbound non-own recipient. Associate by `References`/`In-Reply-To` first; only then use `(normalized subject, normalized counterpart)` as a fallback. Ignore duplicate `message_id` values so repeated syncs cannot create duplicate messages.

- [ ] **Step 4: Remove all application send capability**

Delete `send_reply()` and the `/api/mail/send` route. Remove the `#btn-send` button, its event handler, SMTP visibility logic, and copy that promises in-app sending. Keep only `POST /api/mail/draft`, whose success text says the user must inspect and send from their mailbox.

Replace the old offline-only send test with:

```python
def test_application_has_no_mail_send_endpoint():
    response = client.post("/api/mail/send", json={
        "thread_id": "anything", "subject": "Re: x", "body": "Draft"
    })
    assert response.status_code == 404
```

- [ ] **Step 5: Run workflow-one email and API tests**

Run: `python -m pytest -q tests/test_mailbox.py tests/test_settings.py tests/test_engine.py::test_offline_mail_flow_end_to_end`

Expected: all pass; the fake IMAP log contains `BODY.PEEK[]` and no mutation/send command.

- [ ] **Step 6: Commit the email boundary**

```powershell
git add -- integration/workflow-1/app/tradetwin/mailbox.py integration/workflow-1/app/tradetwin/server.py integration/workflow-1/app/tradetwin/static/index.html integration/workflow-1/app/tradetwin/static/app.js integration/workflow-1/app/tests/test_mailbox.py integration/workflow-1/app/tests/test_settings.py
git commit -m "fix: keep email intake read-only and draft-only"
```

---

### Task 3: Constrain the Alibaba Extension and Add Recent-Message Fallback

**Files:**
- Create: `integration/tests/extension.test.ts`
- Modify: `integration/workflow-1/extension/content.js`
- Modify: `integration/workflow-1/extension/sidepanel.js`
- Modify: `integration/workflow-1/extension/manifest.json`
- Modify: `integration/workflow-1/extension/sidepanel.html`

**Interfaces:**
- Consumes: `tt-read`, `tt-read-draft`, and `tt-insert` extension messages.
- Produces: `{ selection, recent, source, conversationKey, url }` for reads and `{ ok, error }` for safe insertion.

- [ ] **Step 1: Add a VM-based content-script harness**

Use `node:vm` in Vitest to load `content.js` with fake `window`, `document`, and `chrome.runtime.onMessage`. Test through the captured message listener rather than exporting browser-only internals.

Add cases proving:

```typescript
it('prefers selected text over the recent message', () => {
  const result = dispatch('tt-read', fixture({ selection: 'selected buyer text', recent: 'recent text' }));
  expect(result).toMatchObject({ selection: 'selected buyer text', source: 'selection' });
});

it('returns the last visible inbound message when there is no selection', () => {
  const result = dispatch('tt-read', fixture({ selection: '', messages: [inbound('first'), outbound('mine'), inbound('latest')] }));
  expect(result).toMatchObject({ recent: 'latest', source: 'recent' });
});

it('refuses a generic search input and never dispatches submit or keyboard events', () => {
  const result = dispatch('tt-insert', fixture({ active: genericSearchInput() }), { text: 'draft' });
  expect(result.ok).toBe(false);
  expect(dispatchedEvents()).toEqual([]);
});
```

- [ ] **Step 2: Run the extension tests and verify fallback/trust failures**

Run: `npm test -- --run tests/extension.test.ts`

Expected: FAIL because `tt-read` currently returns selection only and insertion accepts any focused text editor.

- [ ] **Step 3: Implement visible recent-message extraction**

For `https://*.alibaba.com/*`, inspect visible message-like nodes only. Exclude editable controls, hidden nodes, known self/outgoing containers, empty text, and duplicated nested text. Return at most the last 4,000 characters of the final inbound candidate. Include `source: "selection" | "recent" | "none"` and the exact chosen text so the side panel can display what will be analyzed.

The side panel must set its editable input from `selection || recent`, show a notice naming the source, and stop with an error if both are empty. The user can edit or cancel before analysis.

- [ ] **Step 4: Restrict reply insertion and strengthen session identity**

Accept only a visible `textarea` or `contenteditable` element whose own attributes or nearby composer container identify it as a chat/reply/message editor. Reject search fields, hidden fields, detached nodes, and arbitrary focused text inputs. Set text and dispatch only `input` and `change`; never dispatch `keydown`, `keypress`, `keyup`, `submit`, or click a button.

Build `conversationKey` from origin/path plus known conversation/RFQ query identifiers instead of dropping all query parameters. Use that key for `state.sessions` so different buyers on one path do not share a workflow session.

- [ ] **Step 5: Route the extension through Node by default**

Set:

```javascript
const state = {
  backend: "http://127.0.0.1:3001/api/workflow1",
  sessions: {}, result: null, lang: "en", pageKey: null,
};
```

Add `http://127.0.0.1:3001/*` and `http://localhost:3001/*` to `host_permissions`. Keep direct port 8000 only as a documented standalone-development override.

- [ ] **Step 6: Run extension and Node tests**

Run: `npm test -- --run tests/extension.test.ts tests/workflow1-proxy.test.ts`

Expected: all tests pass and no test records submit/keyboard/click events.

- [ ] **Step 7: Commit the extension boundary**

```powershell
git add -- integration/tests/extension.test.ts integration/workflow-1/extension/content.js integration/workflow-1/extension/sidepanel.js integration/workflow-1/extension/manifest.json integration/workflow-1/extension/sidepanel.html
git commit -m "feat: add safe Alibaba inquiry capture"
```

---

### Task 4: Validate Workflow-One Case Synchronization

**Files:**
- Modify: `integration/server/workflow1.ts`
- Modify: `integration/shared/types.ts`
- Modify: `integration/tests/workflow1-proxy.test.ts`
- Modify: `integration/src/components/SalesWorkspace.tsx`

**Interfaces:**
- Consumes: a complete workflow-one result posted to `POST /api/workflow1/sync`.
- Produces: `{ case: CaseRecord, replay: boolean }`, where the case stores the exact workflow-one run and a derived quality configuration.

- [ ] **Step 1: Add failing synchronization tests**

Add tests for:

```typescript
it('uses the selected option configuration and stores one audit event per run', async () => {
  const result = workflowOneResult({ selected_option_id: 'C', run_id: 'RUN-1' });
  const first = await postSync(result);
  const replay = await postSync(result);
  expect(first.body.case.requestedConfig).toMatchObject({ powerW: 30, ip: 'IP44', driver: 'DRV-A' });
  expect(replay.body.replay).toBe(true);
  expect(db.listAudit('session-1').filter((e) => e.type === 'workflow1.synced')).toHaveLength(1);
});

it('rejects a priced result when workflow two failed', async () => {
  const result = workflowOneResult({ workflow2: { ok: false }, quote_options: [pricedOption()] });
  expect((await postSync(result)).status).toBe(400);
});

it('syncs pending review without retaining a stale quote-ready flag', async () => {
  await postSync(workflowOneResult({ run_id: 'RUN-priced', quote_options: [pricedOption()] }));
  const pending = await postSync(workflowOneResult({ run_id: 'RUN-pending', quote_options: [], status: 'NEEDS_MANUAL_REVIEW' }));
  expect(pending.body.case.workflow1QuoteReady).toBe(false);
});
```

- [ ] **Step 2: Run the sync tests and verify selected-option/validation failures**

Run: `npm test -- --run tests/workflow1-proxy.test.ts`

Expected: FAIL because the current sync path trusts the payload and always derives configuration from the first option.

- [ ] **Step 3: Add a narrow runtime validator and explicit case fields**

Create a local `parseWorkflow1Result(value: unknown)` in `workflow1.ts`; validate `session_id`, `run_id`, integer positive `round`, ISO-like `created_at`, `change_order`, `workflow2.ok`, `quote_options`, `selected_option_id`, and finite numbers. Reject priced options if `workflow2.ok !== true`, if estimates are `null`, or if their evidence/rule versions are absent.

Add to `CaseRecord`:

```typescript
workflow1LastRunId?: string;
workflow1QuoteReady?: boolean;
workflow1Result?: Record<string, unknown>;
```

Derive `requestedConfig` from the selected option when present, otherwise from the requested option, then from the change order. Persist the complete result for traceability. Set `workflow1QuoteReady` from validated priced options rather than from a stale previous run.

- [ ] **Step 4: Keep synchronization idempotent and audit-safe**

Return the stored case immediately when `workflow1LastRunId === run_id`. For a new run, save the case once and add one `workflow1.synced` audit event whose detail contains round, workflow-two rule version, evidence version, option count, and quote readiness. Do not replace prior audit rows.

- [ ] **Step 5: Make the handoff state visible**

In `SalesWorkspace`, show “报价数据已同步” only when `workflow1QuoteReady` is true; otherwise show “已同步，等待证据/参数确认”. Preserve the existing “打开品质核验” action and recoverable Python-service health error.

- [ ] **Step 6: Run tests, typecheck, and build**

Run:

```powershell
npm test -- --run tests/workflow1-proxy.test.ts tests/workflow2.test.ts
npm run typecheck
npm run build
```

Expected: all tests pass; TypeScript exits 0; Vite and server bundles build.

- [ ] **Step 7: Commit synchronization hardening**

```powershell
git add -- integration/server/workflow1.ts integration/shared/types.ts integration/tests/workflow1-proxy.test.ts integration/src/components/SalesWorkspace.tsx
git commit -m "fix: validate workflow one case synchronization"
```

---

### Task 5: Add One-Command Local Lifecycle and Real HTTP Smoke Coverage

**Files:**
- Create: `integration/scripts/workflows.mjs`
- Create: `integration/scripts/smoke-workflows.mjs`
- Modify: `integration/package.json`
- Modify: `integration/.env.example`
- Modify: `integration/workflow-1/app/run.ps1`

**Interfaces:**
- Consumes: `WORKFLOW1_PYTHON`, `WORKFLOW1_URL`, `PORT`, and the workflow-one/workflow-two URLs.
- Produces: `npm run dev`, `npm start`, and `npm run test:workflows` that manage or verify both services.

- [ ] **Step 1: Add a failing lifecycle smoke assertion**

Create `smoke-workflows.mjs` to call:

```javascript
const nodeBase = process.env.TRADETWIN_API_URL || 'http://127.0.0.1:3001';
const analyze = await json(`${nodeBase}/api/workflow1/analyze`, {
  method: 'POST',
  body: JSON.stringify({
    text: 'Please change the luminaire to 36W and IP44. Keep DRV-A. 100 pcs.',
    channel: 'email',
    source: 'workflow-smoke',
  }),
});
assert.equal(analyze.quote_options[0].estimated_cost_eur, 2100);
assert.equal(analyze.quote_options[0].estimated_days, 8);
const synced = await json(`${nodeBase}/api/workflow1/sync`, {
  method: 'POST', body: JSON.stringify(analyze),
});
assert.equal(synced.case.workflow1LastRunId, analyze.run_id);
```

Continue with a second turn selecting the coverage-range option and hiding the delivery date; assert €900/7 days and no “working days”/“Arbeitstage” in replies.

- [ ] **Step 2: Run the smoke script without services and confirm a clear failure**

Run: `node scripts/smoke-workflows.mjs`

Expected: non-zero exit with `Node API unavailable at http://127.0.0.1:3001`; no unhandled stack dump containing credentials.

- [ ] **Step 3: Implement the cross-platform process supervisor**

`workflows.mjs` must:

- Resolve Python from `WORKFLOW1_PYTHON`, then `python`, then Windows `py -3`; verify with `--version`.
- Start `python -m uvicorn tradetwin.server:app --host 127.0.0.1 --port 8000` in `workflow-1/app`.
- Inject `WORKFLOW2_MODE=http` and `WORKFLOW2_URL=http://127.0.0.1:3001/api/workflow2` into the Python child.
- For `dev`, start `tsx watch server/index.ts` and `vite --host 127.0.0.1` as sibling children.
- For `start`, start `node dist-server/index.js` after confirming the build exists.
- Forward `SIGINT`/`SIGTERM`, terminate every child, and exit non-zero when a required child exits unexpectedly.
- Print one actionable command when Python or dependencies are missing: `python -m pip install -r workflow-1/app/requirements.txt`.

- [ ] **Step 4: Wire package scripts**

Use:

```json
{
  "scripts": {
    "dev": "node scripts/workflows.mjs dev",
    "dev:node": "concurrently -k -n api,web \"tsx watch server/index.ts\" \"vite --host 127.0.0.1\"",
    "start": "node scripts/workflows.mjs start",
    "start:node": "node dist-server/index.js",
    "test:workflows": "node scripts/smoke-workflows.mjs"
  }
}
```

Keep existing `test`, `typecheck`, `build`, `test:smoke`, and `config:export` scripts.

- [ ] **Step 5: Verify lifecycle failure and success paths**

With no Python interpreter, run `npm run dev` and confirm it exits with the documented prerequisite message. After installing Python 3.11+ and `requirements.txt`, run `npm run dev`, wait for both health endpoints, and run `npm run test:workflows`.

Expected success path: first turn €2,100/8 days, second turn €900/7 days, shared case updated, and hidden delivery wording preserved.

- [ ] **Step 6: Commit lifecycle support**

```powershell
git add -- integration/scripts/workflows.mjs integration/scripts/smoke-workflows.mjs integration/package.json integration/.env.example integration/workflow-1/app/run.ps1
git commit -m "feat: run both TradeTwin workflows together"
```

---

### Task 6: Document, Verify, and Visually Inspect the Integrated Product

**Files:**
- Create: `integration/docs/工作流联调.md`
- Modify: `integration/README.md`
- Modify: `integration/docs/验证记录.md`
- Review: `integration/src/App.tsx`
- Review: `integration/src/styles.css`
- Review: `integration/workflow-1/app/tradetwin/static/index.html`
- Review: `integration/workflow-1/app/tradetwin/static/style.css`

**Interfaces:**
- Consumes: completed tasks 1-5.
- Produces: reproducible setup, boundary documentation, actual verification evidence, and a browser-checked unified workflow.

- [ ] **Step 1: Write the integration runbook**

Document exact prerequisites and commands, the two-process topology, `tradetwin.wf2.v1` fields, scheme A/B/C ownership, email/plugin boundaries, evidence-version invalidation, shared-case mapping, failure behavior, and the two-turn demo. Explicitly state that port 8000 is internal workflow one, port 3001 is the API/source of truth, and port 5173 is the development UI.

- [ ] **Step 2: Update README without preserving obsolete duplicate workflow instructions**

Make `npm run dev` the primary entry. Explain Python installation separately, show the extension directory, and state that email only creates a mailbox draft while the extension only fills the page editor. Remove claims that the application can send mail through SMTP.

- [ ] **Step 3: Run the complete automated verification matrix**

Run:

```powershell
cd 'D:\ChatGPT\TradeTwin AI\integration'
npm test
npm run typecheck
npm run build
cd workflow-1\app
python -m pytest -q
cd ..\..
npm run dev
# In another terminal after both services are ready:
npm run test:smoke
npm run test:workflows
```

Record exact pass/fail counts, command dates, model mode, and any unavailable prerequisite in `docs/验证记录.md`. Do not repeat the old `88/88` claim unless this run actually produces it.

- [ ] **Step 4: Inspect the main browser workflow at desktop and mobile widths**

At `http://127.0.0.1:5173`, verify at 1440x900 and 390x844:

- Sales workspace loads through `/sales/` without mixed-origin errors.
- Email and manual inquiry inputs remain usable inside the iframe.
- 36W/IP44 shows the workflow-one options and the workflow-two evidence handoff.
- “打开品质核验” opens the same case and retains the current round.
- Returning to workflow one preserves the same session.
- Service-down state is readable and does not block evidence/knowledge/audit navigation.
- No text, controls, iframe, dialogs, or side navigation overlap.

Save screenshots under the ignored `test-results/` directory and record only verified findings.

- [ ] **Step 5: Manually inspect the unpacked extension**

Load `integration/workflow-1/extension/` in Chrome/Edge developer mode. On an allowed Alibaba page, verify selected-text input, recent-message fallback visibility, manual editing, safe reply insertion, no automatic send, and clipboard fallback when no trusted editor exists. Do not claim full Alibaba compatibility if the live page is unavailable; record the VM tests and the unverified live-site gap separately.

- [ ] **Step 6: Commit documentation and verification records**

```powershell
git add -- integration/README.md integration/docs/工作流联调.md integration/docs/验证记录.md
git commit -m "docs: document dual-workflow operation and verification"
```

- [ ] **Step 7: Final clean-state review**

Run `git status --short`, review every integration diff, and confirm no `.env`, mailbox authorization code, runtime mail, SQLite database, upload, test result, build output, or model key is staged. Report that the workspace root still has unrelated pre-existing untracked artifacts and do not delete them.

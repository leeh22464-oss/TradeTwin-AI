# New Inquiry Channel Intake Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the new-inquiry dialog import real email threads and reviewed browser-extension captures into the shared case workspace.

**Architecture:** Reuse the Python workflow's existing IMAP settings, thread preview, and analysis endpoints for email imports. Store short-lived extension captures in Node SQLite and let a Node orchestration endpoint analyze and sync a selected capture idempotently through the existing workflow-one contract. Update the new-inquiry dialog and the packaged extension side panel to expose those paths while keeping manual entry available.

**Tech Stack:** React 19, TypeScript, Express 5, Node SQLite, Python FastAPI, Chrome Manifest V3, Vitest.

**Spec:** `docs/superpowers/specs/2026-11-01-inquiry-channel-intake-design.md`

## Global Constraints

- Do not send email or Alibaba messages automatically.
- Do not let the web page enumerate or launch installed browser extensions.
- Do not add cloud services, accounts, or remote message storage.
- Do not change compliance calculations, pricing rules, or quote generation.
- Email remains IMAP read-only for inbound messages; generated replies remain drafts and are not sent automatically.
- The extension must show the exact text and source URL before submission; capture is an explicit user action.
- Only HTTPS Alibaba source URLs may be submitted by the extension capture flow.
- Keep all capture persistence local in the existing SQLite database; no message content is written to logs.
- Treat inquiry text as untrusted data; it cannot authorize tools, shell commands, or external communication.

---

### Task 1: Mailbox contract and settings support in the dialog

**Files:**
- Create: `src/components/NewInquiryDialog.tsx`
- Modify: `src/App.tsx`
- Modify: `src/styles.css`
- Test: `tests/new-inquiry.test.tsx`
- Reference: `workflow-1/app/tradetwin/server.py` (`/api/settings/mail`)
- Reference: `workflow-1/app/tradetwin/static/app.js` (`PRESETS`, settings payload)

**Interfaces:**
- Consume `GET /api/workflow1/settings/mail` -> `{ settings: { imap_host, imap_port, user, drafts_folder, signature, has_password }, status }`.
- Consume existing `POST /api/workflow1/settings/mail/test` and `POST /api/workflow1/settings/mail` payload: `{ imap_host, imap_port, user, password, drafts_folder, signature }`.
- Keep password in component state only; blank password on update means retain the stored password.

- [ ] **Step 1: Write a failing component test** using the existing hook harness pattern in `tests/sales-workspace.test.tsx`; assert the default email panel renders its connection status/settings entry, and selecting RFQ switches to extension intake controls.
- [ ] **Step 2: Run `npm test -- --run tests/new-inquiry.test.tsx`**; confirm failure because `NewInquiryDialog` does not yet exist.
- [ ] **Step 3: Create `NewInquiryDialog.tsx`** with an accessible segmented `email/rfq` control, inline manual-entry mode, mailbox settings load/test/save, provider presets matching `PRESETS` in `workflow-1/app/tradetwin/static/app.js` (QQ, 163, 126, Tencent Exmail, Alibaba Exmail, Gmail), and loading/error states. Keep password in component state and use the existing `api()` request pattern.
- [ ] **Step 4: Run the focused test** and assert the email/RFQ panel switch and password-free settings summary; add a failed settings load assertion that keeps the dialog usable.

### Task 2: Email thread selection and case handoff

**Files:**
- Modify: `src/components/NewInquiryDialog.tsx`
- Modify: `src/styles.css`
- Test: `tests/new-inquiry.test.tsx`
- Test: `tests/workflow1-proxy.test.ts`
- Reference: `workflow-1/app/tradetwin/server.py` (`/api/mail/threads`, `/api/mail/thread/{thread_id}`, `/api/mail/analyze`)

**Interfaces:**
- Consume `GET /api/workflow1/mail/threads?refresh=true` -> `{ status, threads: [{ thread_id, subject, buyer_name, buyer_addr, message_count, inbound_count, updated_at, last_message_id, preview, analysis }] }`.
- Consume `GET /api/workflow1/mail/thread/:thread_id` -> `{ thread_id, subject, messages: [{ message_id, from_name, from_email, date, body, body_clean }] }`.
- Consume `POST /api/workflow1/mail/analyze` -> workflow-one analysis result; pass that result to `POST /api/workflow1/sync`.
- On successful sync, close the dialog and open the returned shared `CaseRecord.id`.

- [ ] **Step 1: Add failing tests** named `refreshes and previews mailbox threads`, `imports only the selected email thread`, and `keeps email intake open when analyze or sync fails`. Stub `/api/workflow1/mail/threads`, `/thread/:id`, `/mail/analyze`, and `/sync`; assert import calls contain the selected `thread_id` and opens only the synchronized `case.id`.
- [ ] **Step 2: Run `npm test -- --run tests/new-inquiry.test.tsx`** and confirm these cases fail because the component has no thread list/import path.
- [ ] **Step 3: Implement thread list, preview, refresh, and import** using the existing proxy routes. Do not call `mail/analyze` until explicit import. Reuse result `session_id` as the shared case ID returned by sync.
- [ ] **Step 4: Verify the three tests** against loaded, empty, refreshing, and error states, and assert successful sync closes the dialog while failed import retains the selected thread.

### Task 3: Extension capture persistence and API

**Files:**
- Modify: `shared/types.ts`
- Modify: `server/db.ts`
- Modify: `server/index.ts`
- Test: `tests/api.test.ts`

**Interfaces:**
- Define `ExtensionCapture` with `id`, `sessionId`, `text`, `sourceUrl`, optional `conversationKey` and `pageKey`, `createdAt`, `expiresAt`, `status: 'pending' | 'imported'`, and optional `caseId`.
- Add `AppDatabase.createCapture`, `listPendingCaptures`, `getCapture`, `markCaptureImported`, and `deleteExpiredCaptures`.
- Add `POST /api/extension/captures` accepting `{ text, source_url, conversation_key?, page_key? }` and returning the pending capture summary.
- Add local UI `GET /api/extension/captures` and `GET /api/extension/captures/:id`; expose preview text only in detail responses.
- Validate text length (1..20,000), HTTPS Alibaba URL, Origin scheme, and 10-minute expiry.

- [ ] **Step 1: Write failing repository/API tests** named `creates a pending capture with an opaque stable session id`, `rejects non-Alibaba URLs and invalid text`, `expires captures after ten minutes`, and `marks a capture imported with its case id`. Send extension POST with `Origin: chrome-extension://testid` and UI GET with a localhost Origin.
- [ ] **Step 2: Run `npm test -- --run tests/api.test.ts`** and confirm the new route/repository behavior is missing.
- [ ] **Step 3: Implement SQLite table creation and API routes**. Store text only in SQLite, omit it from logs, accept extension POST only from `chrome-extension://` origins, and restrict UI reads to localhost/127.0.0.1 origins when an Origin is present.
- [ ] **Step 4: Run focused API tests** and verify expired captures cannot be previewed or imported.

### Task 4: Idempotent extension import orchestration

**Files:**
- Modify: `server/workflow1.ts`
- Modify: `server/index.ts`
- Test: `tests/workflow1-proxy.test.ts`

**Interfaces:**
- Add `POST /api/extension/captures/:id/import` returning `{ case: CaseRecord, replay: boolean }`.
- Use stored `capture.sessionId` as `session_id` and POST `{ text, session_id, channel: 'alibaba_rfq', source: 'extension' }` to Python `/api/analyze`.
- Pass the result through the existing workflow-one result validation and sync behavior; persist `caseId` and imported state only after sync succeeds.
- Repeated import returns the persisted case; analysis/sync failures leave the capture pending and retryable.

- [ ] **Step 1: Write failing proxy tests** named `imports an extension capture into a shared case`, `replays a completed capture import without a second analyze or audit event`, `rejects an invalid workflow-one result`, and `leaves a capture pending when workflow-one is unavailable`. Mock the Python HTTP server using the existing `createServer` test fixture and assert the stable stored `session_id` is sent.
- [ ] **Step 2: Run `npm test -- --run tests/workflow1-proxy.test.ts`** and confirm the import endpoint is missing.
- [ ] **Step 3: Implement the import orchestration** with a stable capture session ID, existing result validation, sync fingerprint/replay protection, and transactional imported-state update.
- [ ] **Step 4: Verify focused tests** prove one case and one sync audit event exist after repeated imports.

### Task 5: Extension capture and explicit submit action

**Files:**
- Modify: `workflow-1/extension/sidepanel.html`
- Modify: `workflow-1/extension/sidepanel.js`
- Test: `tests/extension.test.ts`

**Interfaces:**
- Reuse existing `currentPage`, `sendToPage`, selection-first text capture, and `captureIdentity` helpers.
- Add an explicit review-and-submit action that POSTs to Node `/api/extension/captures`, sending bounded text, source URL, and optional conversation/page identity only.
- Disable the action until text is present and the source tab is an HTTPS Alibaba page; show the resulting capture ID/status and clear the editor only after server acknowledgement.
- Keep existing analyze, reply review, reply insertion, and manual copy behavior unchanged.

- [ ] **Step 1: Add failing extension tests** named `submits the reviewed Alibaba capture to Node`, `rejects capture submission from a non-Alibaba page`, and `does not clear text when capture submission fails`. Assert the POST is `/api/extension/captures`, includes only text/source/conversation identity, and does not emit `tt-insert` or a send click.
- [ ] **Step 2: Run `npm test -- --run tests/extension.test.ts`** and confirm the control/handler is missing.
- [ ] **Step 3: Implement the review-and-submit control** and extend loopback `host_permissions` only as required by the existing Node port.
- [ ] **Step 4: Run extension tests** and verify existing reply safety tests remain unchanged and green.

### Task 6: Plugin selection and import in the new-inquiry dialog

**Files:**
- Modify: `src/components/NewInquiryDialog.tsx`
- Modify: `src/styles.css`
- Test: `tests/new-inquiry.test.tsx`

**Interfaces:**
- Consume `GET /api/extension/captures` for summaries and `GET /api/extension/captures/:id` for selected preview.
- Consume `POST /api/extension/captures/:id/import` -> `{ case, replay }`.
- Poll pending captures only while the plugin channel is active; refresh manually as an explicit action; stop polling on close/import.
- On import success, close the dialog and open `case.id`; on failure retain selection and allow retry.

- [ ] **Step 1: Add failing UI tests** named `shows how to capture when no extension messages are pending`, `previews and imports the selected extension capture`, `retains the capture after an import error`, and `returns to the case identified by the import response`. Stub list/detail/import routes and assert source URL/time/text appear before import.
- [ ] **Step 2: Run the focused test** and confirm the plugin panel and import handoff are missing.
- [ ] **Step 3: Implement the plugin panel** with pending capture list, source URL/time/text preview, refresh, import, local extension setup guidance, and manual fallback.
- [ ] **Step 4: Run the focused test** and verify channel changes actually switch the intake workflow.

### Task 7: Integration documentation and full verification

**Files:**
- Modify: `README.md`
- Modify: `docs/工作流联调.md`
- Verify: `tests/*`, production build, local smoke tests.

- [ ] **Step 1: Document mailbox setup, extension reload, capture selection, and local-only behavior** with the actual endpoint/runtime configuration used by the implementation.
- [ ] **Step 2: Run the full test suite** with `npm test`; record the observed result.
- [ ] **Step 3: Run the production build** with `npm run build`; record the observed result.
- [ ] **Step 4: Run the workflow smoke checks** with `npm run test:workflows` and `npm run test:smoke` where the environment supports their runtime prerequisites.
- [ ] **Step 5: Re-read the design spec and verify every user flow**, including manual fallbacks, mailbox thread linkage, extension capture import, expiry/retry, and no-auto-send boundaries.

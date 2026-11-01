# New Inquiry Channel Intake Design

## Context

The React new-inquiry dialog currently stores a manually entered inquiry through `POST /api/cases`. Its `email` or `rfq` channel value only affects the resulting case and later quote generation. It does not connect to the existing email inbox or browser extension. The existing Python workflow already provides local-only IMAP settings, read-only thread listing and preview, and thread analysis that uses the mailbox thread ID as the workflow session ID. The browser extension already captures selected or conservatively identified buyer text on Alibaba pages, previews it, and synchronizes analyzed results into the Node case store.

## Goals

- Make channel selection change the new-inquiry workflow, not just the saved channel value.
- Let a user configure/test the local mailbox, refresh and preview email threads, then explicitly import one thread into the shared case workspace.
- Let a user submit an explicitly reviewed extension capture to the local app, preview it in the new-inquiry dialog, then explicitly import it into the shared case workspace.
- Preserve source identity and original inquiry text so subsequent email rounds remain attached to the original mailbox thread and extension cases remain traceable to their capture source.
- Keep manual entry available for both channels and retain the current no-auto-send behavior.

## Non-Goals

- Do not send email or Alibaba messages automatically.
- Do not let the web page enumerate or launch installed browser extensions.
- Do not add cloud services, accounts, or remote message storage.
- Do not change compliance calculations, pricing rules, or quote generation.

## User Experience

The channel control is a segmented choice between `邮箱` and `浏览器插件`. Changing it switches the source-specific intake panel while keeping the manual-entry fallback available.

For email, the dialog loads mailbox connection status from the existing local settings API. When unconfigured, it exposes the existing mailbox fields and test/save actions. When configured, it can refresh the inbox, list thread summaries, show a selected thread preview, and import it. Import requires an explicit user action and creates the shared case from the chosen message/thread; the case uses the stable mailbox thread ID as its workflow-one session ID. The selected sender, subject, cleaned body, channel, and source message ID are preserved. Failures leave the dialog open and do not create a partial case.

For the browser extension, the dialog shows pending captures sent by the TradeTwin extension from an Alibaba conversation, including capture time, page URL, and buyer text preview. It supports refreshing the pending list, selecting a capture, and importing it. If no capture exists, the panel identifies how to load the extension and submit a reviewed capture. The extension action explicitly sends the captured text to the local application; it never sends a customer reply. Manual paste remains available if the extension is unavailable.

## Architecture and Data Flow

### Email

1. The dialog reads and saves settings through the existing `/api/workflow1/settings/mail` proxy routes; the password remains server-side and the response exposes only `has_password`.
2. The dialog lists and previews threads through `/api/workflow1/mail/threads` and `/api/workflow1/mail/thread/:thread_id`.
3. On explicit import, it requests `/api/workflow1/mail/analyze` for the selected thread. This reuses the existing read-only mailbox logic, preserves the thread ID as the workflow-one session ID, and produces the same workflow result used by the existing `/sales` UI.
4. The result is synchronized through `/api/workflow1/sync`, which creates or updates the shared Node case. The dialog opens that case only after successful synchronization.

### Browser Extension

1. The extension side panel captures text using its existing selection-first and conservative buyer-message reader, displays the capture for review, and requires a deliberate `发送到新建询盘` action.
2. The extension posts a capture to a new same-machine Node endpoint under `/api/extension/captures`. The payload contains bounded text, source URL, and optional page/conversation identity; it contains no reply draft or credentials. The Node app assigns both an opaque capture ID and a stable workflow-one session ID.
3. The Node app stores captures in a dedicated SQLite table with creation/expiration timestamps and pending/imported state. Captures expire after 10 minutes. The local UI can list and preview pending captures; the extension can submit captures and check whether one has been imported. The capture endpoint accepts extension-origin requests only when the Origin uses the `chrome-extension://` scheme, and validates that the source URL is HTTPS on an Alibaba domain. The app and extension remain on the existing local-only trust boundary; no fixed extension ID is assumed.
4. The dialog imports only after explicit confirmation through a single Node import endpoint. That endpoint calls the existing workflow-one `/api/analyze` with the assigned session ID, `channel: alibaba_rfq`, `source: extension`, and captured buyer text, validates the result, then synchronizes it to Node using the existing workflow-one sync logic. The workflow-one session ID becomes the shared case ID.
5. The capture is marked imported only after case synchronization succeeds. The import endpoint is idempotent: retries reuse the same session ID, and repeats after success return the already-created case rather than creating duplicate sessions or audit entries. Analysis or sync failures leave the capture pending and retryable.

## Persistence and Validation

- Add a typed capture record in the shared contract and repository methods for create, list, get, mark-imported, and expiry cleanup.
- Reject empty or over-limit text, malformed/non-HTTP(S) source URLs, expired/unknown IDs, and repeated consumption without a successful prior import.
- Never return mailbox passwords or store extension credentials.
- Keep all capture persistence local in the existing SQLite database; no message content is written to logs.
- Keep the current `/api/cases` manual path unchanged for manual entry.

## Error Handling

- Mail settings test/save errors and IMAP synchronization errors are shown within the dialog with retry available; they do not discard manual fields.
- A mailbox thread that disappears between listing and import reports an actionable error and refreshes the list.
- Extension service/backend unavailable states show setup/retry guidance while preserving manual paste.
- If analysis succeeds but synchronization fails, retain the workflow result for an explicit retry, matching the existing extension sync behavior; do not report case creation until sync succeeds.
- Expired captures are removed from the selectable list and the user is asked to capture again.

## Testing and Acceptance

- API tests cover mailbox settings/list/preview/import contracts, local-origin restrictions, capture validation, expiry, atomic consume, and duplicate-import idempotency.
- Extension tests cover capture preview, explicit send action, bounded payload fields, and the absence of message-send behavior.
- React tests cover email/plugin conditional panels, settings and inbox states, capture selection, error/retry states, and successful handoff to the created shared case.
- Existing workflow-one, case API, and extension safety suites remain green.
- Manual verification covers: unconfigured mailbox setup; configured mailbox thread import retaining the thread/session ID; extension capture preview/import; and both manual fallbacks.
- Build and test results must be reported as actually observed. Live email and logged-in Alibaba checks require user credentials and remain unclaimed unless performed.

## Security and Safety Boundaries

- The app remains a local single-user prototype. Capture endpoints are not exposed as a remote ingestion service and use the existing local-only trust boundary; extension-origin requests are accepted only from the browser extension scheme.
- The extension must show the exact text and source URL before submission; capture is an explicit user action.
- Only HTTPS Alibaba source URLs may be submitted by the extension capture flow.
- The extension continues to have no send/submit capability for customer replies.
- Email remains IMAP read-only for inbound messages; generated replies remain drafts and are not sent automatically.
- All imported inquiry text is untrusted data and cannot authorize tools, shell commands, or external communication.

## Rollout

Implement behind the existing new-inquiry dialog and current extension package. No schema migration is required beyond additive table creation. Keep manual entry usable if either source integration is unavailable. Update the integration README with extension reload and email setup steps once implementation is complete.

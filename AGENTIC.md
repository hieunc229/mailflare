# Agentic email and MCP implementation plan

Status: initial implementation added September 24, 2026. The feature contract and acceptance checklist below describe the intended complete design. The implementation status at the end distinguishes shipped code from remaining work. No build or validation commands were run, per the project's `AGENTS.md` instruction.

## Goal and recommended scope

Add a built-in email assistant, automatic draft replies for eligible inbound mail, and an MCP server for external assistants. Reuse Mailflare's mail storage, composer, search, permissions, and delivery services. Every agent-originated send must require a human to review and explicitly approve the exact outgoing message.

Recommended first release:

- A mailbox-aware side panel with nine email tools, persistent private conversations, streaming responses, visible tool activity, and links into the existing composer.
- Opt-in auto-drafting per mailbox, with one designated reviewer and durable background jobs.
- An authenticated `/mcp` endpoint exposing the same mail operations, plus mailbox discovery and draft updates. External assistants request a send review; approval happens in Mailflare.
- Cloudflare and Docker support through shared application services and runtime-specific model/queue adapters.

Keep autonomous sending, arbitrary third-party MCP connections, attachment interpretation, web browsing, permanent email deletion, bulk actions, and collaborative shared chat out of the first release.

## What the reference actually implements

Source snapshot: Cloudflare's [agentic-inbox at commit `48039bb`](https://github.com/cloudflare/agentic-inbox/tree/48039bb6785af34e592c2966f87cde2b255c4c80). The implementation is more precise than the README's description of “9 email tools … and sending.”

| Area | Observed behavior | Adaptation for Mailflare |
| --- | --- | --- |
| Built-in agent | `EmailAgent` extends `AIChatAgent`; nine tools, none of which sends email. Uses Workers AI, streaming chat, and a five-step limit. | Keep the nine-tool draft-first workflow; provide explicit send review through the UI. |
| Auto-draft | Inbound storage triggers `/onNewEmail` through `ctx.waitUntil`. The agent reads the email/thread, uses fresh model context, and saves a draft. | Use recoverable jobs after successful intake; do not make model availability part of mail delivery. |
| Prompt and history | Mailbox prompt settings live in R2; agent history lives in a mailbox-named Durable Object. | Store settings/history in D1 or SQLite; private conversations belong to a user and mailbox. |
| Draft quality | Scans inbound/thread text for prompt injection and uses a second model to remove commentary from drafts. | Treat scans as optional defense; enforce authority in code and reject malformed/empty drafts. |
| MCP | `EmailMCP` registers 13 tools, including direct send and permanent deletion. Shared helper functions serve both MCP and chat. | Share one authorized service layer; omit permanent deletion and replace direct sending with review requests. |
| Authentication | Cloudflare Access is the single trust boundary; authorized users can operate on all mailboxes. | Preserve Mailflare's account, delegation, disabled-account, and mailbox checks on every operation. |
| UI | Agent panel displays streaming Markdown, tool activity, and a composer handoff; MCP panel displays connection information. | Follow existing Mailflare components, navigation, and composer behavior. |

These observations come from the pinned [agent implementation](https://github.com/cloudflare/agentic-inbox/blob/48039bb6785af34e592c2966f87cde2b255c4c80/workers/agent/index.ts), [MCP implementation](https://github.com/cloudflare/agentic-inbox/blob/48039bb6785af34e592c2966f87cde2b255c4c80/workers/mcp/index.ts), [shared tools](https://github.com/cloudflare/agentic-inbox/blob/48039bb6785af34e592c2966f87cde2b255c4c80/workers/lib/tools.ts), [inbound handler](https://github.com/cloudflare/agentic-inbox/blob/48039bb6785af34e592c2966f87cde2b255c4c80/workers/index.ts), [authentication/routing](https://github.com/cloudflare/agentic-inbox/blob/48039bb6785af34e592c2966f87cde2b255c4c80/workers/app.ts), and [agent UI](https://github.com/cloudflare/agentic-inbox/blob/48039bb6785af34e592c2966f87cde2b255c4c80/app/components/AgentPanel.tsx).

Important distinction: the reference MCP send descriptions ask the caller to obtain confirmation, but their handlers accept message content and call delivery without a server-side approval record. That does not enforce the approval requirement needed here. Its built-in agent avoids this by having no send tool.

## Existing Mailflare foundations and integration gaps

| Existing area | Relevant files | Implication |
| --- | --- | --- |
| Next.js/React UI | `src/app/(dashboard)/layout.tsx`, `src/components/messages/message-split-layout.tsx` | Mount one agent provider/panel in the dashboard shell; avoid duplicating it for each folder. |
| Composer and drafts | `src/components/compose/`, `src/app/api/drafts/`, `src/app/(dashboard)/drafts/` | AI drafts should be ordinary `messages` rows with `status = draft`, supplemented with provenance. |
| Draft ownership | `src/app/api/drafts/utils.ts`, `src/app/api/drafts/[id]/utils.ts` | Draft APIs currently enforce individual ownership. Auto-drafts need an explicit reviewer, not a mailbox-wide shared draft assumption. |
| Mailbox access and sender identity | `src/lib/mailboxes/access.ts`, `src/lib/email/sender.ts` | Reuse read/send/manage capabilities, domain identities, and send-on-behalf display rules. Admin status does not automatically grant mailbox access here. |
| Read/thread/search | `src/lib/email/inbound.ts`, `src/lib/email/thread-view.ts`, `src/lib/search/`, `src/app/api/messages/route.ts` | Reuse authorized reads and search conditions. Thread lookup currently takes a message ID and caps results at 200. |
| Inbound processing | `worker.ts`, `src/lib/email/inbound.ts`, `src/lib/email/intake.ts` | Attach auto-draft scheduling to the common processor used by Cloudflare and Node/relay intake. |
| Existing automatic replies | `src/lib/email/auto-reply.ts` | Out-of-office replies already send automatically; AI auto-drafts must be a separate setting and execution path. |
| Delivery | `src/app/api/send/route.ts`, `src/lib/email/send.ts` | Immediate sends call the provider directly; scheduled sends use `OUTBOUND_QUEUE`. An approval/deduplication layer must precede either path. |
| External API authentication | `src/lib/api/key-auth.ts`, `src/lib/api/scopes.ts` | Reuse key hashing/authentication, but add MCP-specific scopes and mailbox restrictions. Existing scopes are `send`, `read`, `jmap`, and `domains`. |
| Realtime | `src/lib/realtime/`, `src/hooks/message-realtime-utils.ts` | Extend the event union and query invalidation for draft/job changes; current notifications are `new_message`. |
| Runtime portability | `src/lib/runtime.ts`, `server/runtime/env.ts`, `server/runtime/queue.ts`, `server/runtime/scheduler.ts` | Node queue timers are in-memory. Persist AI jobs and recover them after restart. |
| Schema/deployment | `src/db/schema/index.ts`, `drizzle/migrations/`, `wrangler*.jsonc`, `env.d.ts` | Add additive migrations, model configuration, queue bindings, and documented runtime configuration. |

There are no AI SDK/Agents/MCP dependencies in the inspected `package.json`.

## Feature details

### 1. Built-in assistant panel

- Add an Assistant button beside the existing dashboard header controls. Open a resizable right panel on desktop and an accessible drawer on narrow screens; preserve room for message details and the floating composer.
- Display the selected mailbox and optional selected-email context above chat. Require a specific mailbox when the user is viewing an aggregate inbox. Switching mailboxes switches conversation scope and cancels the old stream.
- Provide starter actions such as “Summarize this thread,” “Find emails about…,” and “Draft a reply.” Only fetch full message bodies when needed. Reading through the assistant must not implicitly mark mail as read.
- Persist conversations per `(userId, mailboxId, conversationId)`. Include streamed text, tool status, errors, and draft references. Other delegates must not see private chat history.
- Offer stop, retry, new conversation, and delete history. Store the user turn before starting generation; persist tool effects/results as they happen. On interruption, show the saved partial result and reconcile completed tools before retrying.
- Show tools as readable activity cards, for example “Reading thread” and “Draft created.” Show failure reasons without dumping raw headers, storage keys, or credentials.
- Draft cards offer Open in composer, Regenerate, and Discard. Regenerate creates a new suggestion or requires explicit replacement; it must not overwrite a human-edited draft.
- Render chat Markdown without raw HTML or automatic remote images. Generate email text separately from chat commentary; convert text safely for the existing rich-text composer and apply signatures once.

### 2. Ten built-in email tools

Use one schema/handler registry with adapters for the model and MCP. Chat binds its mailbox on the server; the model cannot switch it by inventing an argument. MCP accepts a mailbox ID and validates it against the authenticated principal's allowed mailboxes.

| Tool | Inputs and result | Required behavior |
| --- | --- | --- |
| `list_emails` | Folder/status filter, cursor, bounded limit; returns metadata and next cursor. | Authorized mailbox only; default 20, maximum 50. Show only the caller's drafts. |
| `get_email` | Message ID; returns text body, metadata, attachment metadata, and truncation information. | Verify message belongs to the active mailbox; omit attachment bytes and internal storage keys. |
| `get_thread` | Anchor message ID; returns chronological messages, the internal note, and continuation/truncation information. | Adapt existing thread service; enforce mailbox and draft-owner boundaries on every returned row. The note is beside the messages, marked internal, and is not a message. |
| `set_note` | Anchor message ID and body; returns the saved note, or null when cleared. | One note per conversation, visible to whoever can already read the mailbox. Never quoted, forwarded, searched, or sent. An empty body clears it. MCP scope is `mcp:note`. The in-app assistant does not call it. |
| `search_emails` | Query, optional folder, cursor; returns snippets and IDs. | Reuse Mailflare search semantics and indexes; no model-supplied SQL. |
| `draft_email` | Recipients, subject, body; returns draft ID and composer link. | Require sender permission; resolve From server-side. Save under the requesting user. |
| `draft_reply` | Source message ID, body, reply/reply-all mode; returns linked draft. | Derive recipients and RFC threading headers server-side. Handle Reply-To, aliases, and self-address exclusion using shared reply logic. |
| `mark_email_read` | Message ID and read boolean; returns updated state. | Apply existing Mailflare mutation permissions; add unread support in the shared service if needed. |
| `move_email` | Message ID and allowed destination; returns updated state. | Reuse existing move/status policy. Validate custom-folder ownership. Never manufacture sent/draft state or permanently delete. |
| `discard_draft` | Draft ID and expected revision; returns discarded state. | Caller-owned draft only; require an explicit user action before discarding human-edited content. |

Read tools require `canRead`; draft creation requires `canSendOnBehalf` or stronger and the existing sender resolver. For read/move mutations, carry through the actual existing per-operation permission checks rather than treating readable mail as universally writable. Each handler rechecks access when it runs, including after a long model response.

Return structured results such as IDs, operation status, revision, pagination, and safe display text. Use stable errors such as `not_found`, `permission_denied`, `conflict`, `rate_limited`, and `provider_unavailable`.

### 3. Explicit send approval

These tools cannot invoke `sendEmail`, enqueue outbound jobs, approve messages, or change scheduling. A user asking “send it” in chat opens a review action; natural-language assent is not a reusable authorization token.

1. Persist a draft revision before presenting approval. Show From, To, CC, BCC, subject, body, attachment list, and any scheduled delivery time.
2. Create a pending approval bound to the user, mailbox, draft ID/revision, and a server-calculated hash of the complete outgoing payload, including attachment identifiers/content hashes and threading headers.
3. An authenticated browser action labeled **Confirm and send** approves that snapshot. Require same-origin/CSRF protection and fresh mailbox/sender authorization. MCP keys and model tools cannot call the approval action successfully.
4. Atomically claim the approval and create one durable delivery command with a unique approval ID. Reject expired, cancelled, already-claimed, or stale approvals. Editing the draft or attachments invalidates approval and requires a new review.
5. Dispatch that immutable command through the existing delivery service. Record the resulting message/job ID and consume the draft only after a durable handoff. Repeated clicks return the existing delivery status.

Use a short approval lifetime, initially 15 minutes. Treat scheduled AI mail the same way; changing its schedule requires renewed approval. Do not expose automatic scheduling in the initial agent tools.

The current provider-send path is not an exactly-once transaction with the database. Add command-level deduplication, and handle a timeout after provider acceptance as an **unknown delivery outcome** requiring reconciliation; do not blindly retry and risk duplicate email. Audit the reviewer separately from the AI run/MCP key that proposed the draft.

Apply this flow to the AI draft card, MCP review requests, and AI drafts opened in the composer. Enforce the draft provenance/revision checks server-side in the relevant send entry points. Existing manual-email and out-of-office workflows retain their current semantics; MCP credentials must not have legacy `send`, `jmap`, or wildcard privileges that could bypass review.

### 4. Auto-draft on inbound email

Settings: enabled (default off), custom writing instructions, designated reviewer (default mailbox owner), allowed folders, optional sender filters, and daily draft limit. Only the mailbox owner or a delegate with management permission may change mailbox-wide settings. A reviewer must be enabled and retain read/send permission.

Initial eligibility: newly received, successfully stored inbound messages in the configured inbox/folders. Skip spam, trash, blocked senders, imported historical messages, self-mail, mailing lists, bounces, no-reply senders, and automatic responses. Reuse/extract the existing auto-reply header checks without changing out-of-office behavior. Skip suspicious messages or failed spam analysis by default. Default to skipping AI auto-drafts when mailbox out-of-office replies are enabled; explain that policy in settings.

Processing flow:

1. Complete MIME parsing, routing, spam classification, thread assignment, and attachment storage.
2. Persist an eligible auto-draft job with a unique `(mailboxId, sourceMessageId, jobKind)` key. Persist enough intake state to repair the gap between mail storage and job creation. A queue payload carries only the job ID.
3. Dispatch independently of inbound delivery. Claim jobs with an expiring lease and bounded retries; Cloudflare Queue redelivery and Node restarts must not create duplicate drafts.
4. Recheck mailbox configuration, source status, reviewer access, existing replies/drafts, and daily budget. Serialize work per mailbox/thread and mark obsolete jobs superseded when newer messages make them stale.
5. Read the latest message and bounded recent thread context into a fresh model run, independent of private chat history. Signal truncation; do not claim to have read the full conversation when limits were reached.
6. Give this background run only source/thread read access and permission to create one reply draft for that source. It cannot search unrelated conversations, move mail, delete drafts, choose arbitrary recipients, or send.
7. Validate structured draft output, sanitize it, resolve recipients/threading deterministically, and save a standard draft owned by the reviewer with AI provenance. Do not turn arbitrary model commentary into a fallback email.
8. Publish a draft-ready event to the reviewer, with an inbox badge/card linking to the composer. Sending follows the approval flow above. Record skipped/failed jobs with a reason and an explicit retry action.

Keep all mail delivery successful even if generation, scanning, notification, or queue dispatch fails. A durable recovery sweep must recover pending dispatches and expired leases. The current inbound duplicate check returns immediately for an already stored `(mailboxId, rawR2Key)`; modify that branch narrowly to reconcile missing AI work, otherwise retries can permanently miss auto-drafts. Avoid triggering work for historical/imported messages during recovery by persisting an intake eligibility marker. R2 writes and SQL writes are not one transaction: represent incomplete intake explicitly and reconcile before marking a job ready.

Initial limits: one active generation per mailbox, five model steps per interactive turn, at most 20 recent thread messages and a bounded text/token budget, three background attempts with backoff, and 25 automatic drafts per mailbox per day. Make these configurable server-side and tune them from measured use.

### 5. MCP integration

Expose an MCP **server** for external clients; the built-in assistant calls the shared service layer directly. Connecting the built-in assistant to arbitrary external MCP servers is separate future work.

- Serve `/mcp` over HTTPS with the official SDK's Streamable HTTP implementation. Prefer request-scoped/stateless transport. Pin a supported protocol/SDK combination and document client compatibility instead of hand-writing JSON-RPC or copying the reference's transport unchanged. MCP transport/version semantics have evolved; consult the [transport specification](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports) during implementation.
- MVP authentication: dedicated revocable Bearer API keys for clients that support custom headers. Reuse key verification, but require an explicit MCP credential kind/opt-in and mailbox allowlist; existing keys gain no new rights automatically. This is a limited compatibility mode, not a claim of universal OAuth-based MCP compatibility.
- Add `mcp:read`, `mcp:note`, `mcp:draft`, `mcp:organize`, and `mcp:request-send` scopes. Require the matching scope plus current user/mailbox permission. `list_mailboxes` returns the intersection of current access and the key allowlist. Carry key ID in auth context for revocation/auditing; it is absent from the current `ApiAuthResult`. `set_note` uses `mcp:note`, not `mcp:read`.
- Reject mixed MCP/legacy-send/JMAP/wildcard credentials in this mode. Do not accept browser session cookies as MCP authentication. Never put keys in URLs or chat messages.
- Expose the shared email tools, including `set_note`, plus `list_mailboxes`, `update_draft` with expected revision, `request_send`, and `get_send_request`. Map each tool to its scope, and check scope in execution as well as discovery. The in-app assistant does not receive `set_note`.
- `request_send(draftId, expectedRevision)` returns `pending_approval`, an approval ID, and a Mailflare review URL. `get_send_request` returns pending/sent/failed/expired status to the originating authorized principal. Neither operation grants approval or sends directly. Document this intentional difference from upstream `send_email`/`send_reply`.
- Validate Origin when present, bound inputs/results and request rates, and authenticate every request. If compatibility requires stateful sessions, bind each session to the same user/key and recheck access; a session ID is not authorization.
- Add a connection screen showing the endpoint, supported client/auth mode, selected mailboxes, scopes, last use, and revocation. Show newly generated secrets only once; generated examples use placeholders after that.

OAuth discovery/authorization for clients without header-based credential setup is a later milestone. Follow the applicable MCP authorization specification rather than passing session cookies or Cloudflare admin tokens to clients.

## Architecture and storage

Recommended architecture is a portable AI SDK service using existing Next.js streaming routes, with D1/SQLite persistence. Use Workers AI on Cloudflare and a configured server-side HTTP model provider on Docker. This avoids introducing a second mailbox database or two different chat persistence implementations.

Cloudflare's `AIChatAgent` is a valid alternative when Durable Object persistence and resumable streaming are the priority; those capabilities are provided by [`@cloudflare/ai-chat`](https://developers.cloudflare.com/agents/communication-channels/chat/chat-agents/). It would require a separate Node adapter and additional authorization around agent instance routing. Defer that dependency in the initial portable implementation; automatic stream resumption is not promised by the proposed plain HTTP streaming approach.

```text
Assistant panel -> authenticated chat route -> bounded model/tool loop
External client -> /mcp + scoped API key ----> shared authorized mail tools
                                                   |
                                      existing D1/SQLite + R2/files

Inbound processor -> durable AI job -> runtime dispatcher -> reply draft
Human review -> revision-bound approval -> durable send command -> delivery
```

Proposed additive schema:

| Entity | Main fields / constraints |
| --- | --- |
| `mailbox_agent_settings` | Mailbox PK, enabled, autoDraftEnabled, reviewerUserId, instructions, version, filters, dailyLimit, updatedAt. |
| `agent_conversations` | ID, userId, mailboxId, title, createdAt, updatedAt; scoped history index. |
| `agent_chat_messages` | Conversation ID, sequence, role, validated parts JSON, runId, status; unique sequence and client message ID for deduplication. |
| `agent_runs` | Actor/reviewer, mailbox, conversation/source message, mode, status, model, settings version, timestamps, token usage, safe error; atomic budget reservation. |
| `agent_jobs` | Source message/mailbox, kind, reviewer, status, attempts, nextAttemptAt, leaseUntil, runId, draftId, skip reason; unique inbound job key. |
| `agent_draft_metadata` | Draft message PK, origin (`chat`, `auto`, `mcp`), source message/run/key, revision, humanEditedAt, stale/superseded marker. |
| `agent_send_approvals` | Principal, mailbox, draft/revision, payload hash/snapshot reference, expiry, status, reviewedBy, commandId; single-use claim. |
| `agent_send_commands` | Unique approval ID, immutable payload reference, dispatch state, lease, message/job ID, delivery outcome and timestamps. |
| API key extension | Credential kind and mailbox allowlist, preferably a join table; scopes remain explicit. |
| Intake recovery marker | Source message, intake completion, eligibility/settings snapshot, and dispatch reconciliation state. |

Reuse `messages` for draft bodies and existing attachment storage; do not duplicate email bodies in job payloads. Add revision tracking on every AI draft mutation path, including composer autosave and attachments. Personal manual drafts need not acquire AI approval semantics.

Delete conversation history on user request; use a configurable retention policy (proposed default 30 days for completed chat/run details). Keep minimal audit/approval records according to the existing installation's retention policy. Include new tables in backup/restore; pause recovered jobs after restore until configuration and reviewer access have been reconciled.

## Implementation map

New code should follow the repository convention: helper functions in separate files in the same folder (`utils.ts` or purpose-specific modules), type definitions in adjacent `types.d.ts`. Inspect and preserve all manual edits before touching existing integration points; do not reformat adjacent code.

| Location | Planned responsibility |
| --- | --- |
| `src/lib/agent/` | Tool registry/schemas, authorized adapters, model loop/provider adapter, prompt construction, context limits, run persistence, draft validation. |
| `src/lib/agent/jobs/` | Eligibility, durable job claims, generation, reconciliation, budget handling; adjacent types. |
| `src/lib/agent/approvals/` | Snapshot hashing, revision checks, browser approval, durable delivery commands. |
| `src/lib/mcp/` | Server registration, transport adapter, dedicated-key authentication, scope enforcement, MCP result formatting. |
| `src/app/mcp/route.ts` | Thin Next.js entry point for `/mcp`; keep compatible with OpenNext and Node. |
| `src/app/api/agent/` | Chat stream, conversations/history, settings, job retry/status, send review/confirmation endpoints. |
| `src/components/agent/` | Provider, toggle/panel, chat messages, tool cards, draft cards, approval UI, settings and connection details. |
| Existing dashboard/composer/settings files | Mount UI, provide selected-mail context, open generated drafts, route AI draft sends through review. |
| Existing draft/read/search/send services | Extract only the functionality needed for reuse; preserve established permissions and manual behavior. |
| `src/lib/email/inbound.ts`, `worker.ts`, `worker-utils.ts` | Intake/recovery hook and explicit dispatch of AI jobs. Current worker fallback treats unknown queue payloads as outbound: replace that ambiguity before adding a job kind. |
| `server/runtime/` | Durable-job startup recovery and periodic dispatcher; HTTP model configuration; retain current email transport adapters. |
| `src/lib/realtime/`, relevant hooks | Draft/job event types and authorized notifications/query invalidation on both runtimes. |
| Schema/migrations/config/docs | Additive schema, AI queue and provider configuration, MCP scopes/key UI, deployment and self-hosting instructions. |

Dependencies to evaluate and pin during implementation: `ai`, its React integration, `workers-ai-provider`, an HTTP model-provider adapter, the official MCP TypeScript SDK, and a Markdown renderer if needed. Mailflare uses Zod 4; the reference uses Zod 3, so do not copy its dependency versions or tool typings blindly. No model/provider credentials enter client bundles. On Cloudflare, add the [`AI` binding](https://developers.cloudflare.com/workers-ai/configuration/bindings/) and a dedicated agent queue; use a frequent recovery schedule alongside the existing backup cron. Docker uses persisted jobs with its local scheduler and server-only provider credentials. Missing AI configuration disables generation gracefully; authorized MCP reads/draft CRUD can still work without a model.

## Delivery sequence and acceptance criteria

These are acceptance criteria for the feature; they have not been verified in this change.

### Phase 1 — Authorized mail service and persistence

Add schema, principal context, dedicated MCP credentials, revision-aware draft operations, and the shared nine-tool registry. Resolve reply identity/threading and reviewer ownership before wiring a model.

Acceptance: inaccessible mailbox/message IDs never return data; read-only delegates cannot draft/send; each delegate's personal drafts remain private; aliases and send-on-behalf identity follow existing behavior; stale revisions fail without overwriting user edits.

### Phase 2 — Interactive agent and review flow

Add provider configuration, bounded tool loop, private persistent history, panel/composer integration, approval snapshots, and durable send commands. Make the feature opt-in and initially enable it for a single mailbox.

Acceptance: users can summarize/search/draft with visible tool results; history survives refresh; cancellation leaves recoverable state; no model tool sends; edits invalidate approval; repeated approval clicks create one command; provider-acceptance uncertainty never causes blind resend. Verify usability on narrow and wide layouts during implementation.

### Phase 3 — MCP

Add transport and connection settings using the shared services. Document the supported protocol versions and authentication mode with actual client examples once integration is exercised.

Acceptance: scoped clients discover and use allowed tools; revoked/disabled principals lose access; cross-mailbox IDs and legacy send endpoints cannot bypass scope; a send request remains pending until a Mailflare browser approval; MCP reading/drafting works without a configured AI model.

### Phase 4 — Auto-drafting

Add mailbox settings, intake eligibility/reconciliation, background generation, notifications, skip reasons, retry, and daily limits. Roll out to a small mailbox set before enabling broadly.

Acceptance: one eligible inbound message produces at most one initial AI draft; queue redelivery/restart does not duplicate it; a crash between storage and dispatch is recovered; spam/imports/automatic responses are skipped; newer thread activity and human edits are preserved; failed generation does not fail inbound mail; auto-drafts never enqueue outgoing email.

### Phase 5 — Runtime and rollout completion

Complete Cloudflare and Docker configuration, model budgets, usage/error visibility, retention, backup/restore handling, and operational docs. Exercise the authorization, approval, retry, and interruption scenarios above when implementation work is authorized; avoid unrelated cleanup.

Acceptance: both deployments support the documented feature set, with helpful disabled states when providers are unavailable. Disabling the feature stops new runs/dispatches, expires pending agent approvals, and leaves existing drafts editable. Already confirmed delivery commands require an explicit cancellation decision rather than silently disappearing.

## Proposed defaults and later decisions

- Enable nothing automatically on upgrade. Mailbox owners explicitly enable the assistant/auto-drafts and choose a reviewer.
- Keep AI instructions additive to mandatory server policy; custom prompts cannot grant tools, broaden mailbox access, or remove approval.
- Treat all email content and tool results as untrusted data. Only the app establishes recipients, authority, and approval. Model-based injection scans cannot replace these controls.
- Show the configured provider and explain that selected email/thread content is sent to it when enabling AI. Log IDs, timing, usage, and error categories rather than message bodies or credentials.
- Choose the production model after evaluating tool calling, reply quality, latency, and cost. The reference's Kimi model is a research observation, not a required or permanently available default.
- Later decisions: OAuth MCP compatibility, attachment analysis, shared team draft ownership, optional Cloudflare `AIChatAgent` transport, and broader model-provider selection. None should weaken explicit approval for agent-originated delivery.

## Implementation status (September 24, 2026)

The initial implementation adds the mailbox-scoped assistant panel, nine shared email tools, private persisted chat with streaming text and tool activity, AI draft provenance, reviewer-bound send approval, automatic reply-draft jobs, and a Bearer-key MCP server. Agent send requests use a 15-minute payload snapshot and an authenticated browser confirmation. The database prevents two approvals for one draft from both reaching claimed or delivered status. The composer routes agent drafts through review; model tools and MCP tools have no direct send operation. Cloudflare and Node runtime configuration, migrations, and operator documentation are included. All settings default off.

The current implementation is **not yet a verified production release**. The following parts of the design remain incomplete or need integration exercise:

- No build, typecheck, migration exercise, runtime test, or browser review was run, as instructed by `AGENTS.md`. Validate the MCP SDK adapter, AI provider adapters, Cloudflare queue binding, Node startup, and migration before deployment.
- Auto-draft jobs are durable and lease-based, with one active lease per mailbox and a daily completed-draft limit. There is no separate atomic model-cost reservation, and an unusually long generation that outlives its lease still needs reconciliation. The current plain-text model output is checked for emptiness and common commentary prefixes, not parsed as a structured reply.
- There is no separate immutable send-command/outbox table. A claimed approval calls the existing delivery service once, and an uncertain provider outcome remains `unknown` for manual reconciliation. This avoids automatic duplicate retries but does not provide transactional exactly-once delivery.
- The assistant panel has a fixed width. Auto-draft cards can open, request a new draft through chat, or discard the current draft; richer tool progress, mobile accessibility review, and multi-mailbox selection in the MCP key UI remain to be completed. The MCP key API supports explicit scopes and mailbox allowlists; the UI supports scope selection for the current mailbox.
- Optional sender/folder filters, suspicious-content scanning, intake-completion markers, model usage audit/budget reservation, and restore-time pause/reconciliation are not implemented. Default eligibility is limited to newly received inbox mail and skips known automated/self/spam/error cases.
- MCP uses scoped Bearer keys for clients that can set headers. OAuth-based client authorization remains a later milestone.

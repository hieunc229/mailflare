import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { dialectOf } from "@/db/introspect";
import { agentSendApprovals, messages } from "@/db/schema";
import { confirmAgentSend } from "@/lib/agent/approvals/utils";
import { createAuditLog } from "@/lib/mailboxes/audit";
import type { McpPrincipal } from "./types";

/** Why an approval was refused. `permission_denied` and `not_found` say "you may not do this"; `expired` says the request is gone; `unsupported_dialect` says this deployment cannot promise a single send. */
export type ApproveSendRefusal = "permission_denied" | "not_found" | "expired" | "refused" | "unsupported_dialect";

export type ApproveSendOutcome =
	| { ok: true; approvalId: string; status: string; messageId: string | null }
	| { ok: false; error: string; code: ApproveSendRefusal; approvalId?: string; status?: string };

/** `queued` while the outbound job still waits (a scheduled time or the undo window), `sent` once the provider accepted it. */
async function deliveryStatus(env: CloudflareEnv, messageId: string) {
	const [row] = await getDb(env).select({ status: messages.status }).from(messages).where(eq(messages.id, messageId)).limit(1);
	return row?.status === "queued" ? "queued" : "sent";
}

/**
 * `approve_send` for MCP keys: the same transition as the review page's Approve button
 * (`confirmAgentSend`), gated by a per-key flag and by who created the review request.
 *
 * Only a key that has `canApproveOwnSends` may use it, and only on a review request that key
 * created itself (`agent_send_approvals.request_key_id`). The approving key id comes from the
 * authenticated key, never from the caller. Every release is written to the audit log.
 */
export async function approveAgentSend(
	env: CloudflareEnv,
	principal: McpPrincipal,
	input: { mailboxId: string; approvalId: string },
	publicOrigin?: string,
): Promise<ApproveSendOutcome> {
	// 1. The key needs the send-review scope and this mailbox, as `request_send` does.
	if (!principal.scopes.includes("mcp:request-send") || !principal.mailboxIds.includes(input.mailboxId)) {
		return { ok: false, error: "Permission denied", code: "permission_denied" };
	}
	// 2. Per-key flag, off by default: holding a key alone never releases a send.
	if (!principal.canApproveOwnSends) {
		return { ok: false, error: "Permission denied: this key may not approve its own sends", code: "permission_denied" };
	}
	// 3. Single-send is a database guarantee, and MySQL does not have it here. The other dialects create
	// `agent_send_approvals_delivery_idx` as a partial UNIQUE index on (draft_id) where status in
	// ('claimed','sent','unknown') — src/db/schema/index.ts:1366, drizzle/migrations/0032_add_agentic_mail.sql
	// and drizzle/migrations-pg/0000_baseline.sql:754 — so only one approval per draft can ever be claimed.
	// MySQL cannot express that partial index: drizzle/migrations-mysql/0000_baseline.sql:823 creates a
	// plain nonunique index of the same name, so `requestAgentSend`'s check (utils.ts:51-59) is only a
	// pre-check there and two pending approvals for one draft can both be claimed and both enqueued.
	// Refusing is the honest answer; the web review page keeps working, and `approve_send` comes back once
	// MySQL has an equivalent constraint (a generated column that is NULL outside the delivery states,
	// unique on (draft_id), or an explicit per-draft send lock table), which a baseline edit cannot give
	// existing deployments anyway.
	if (dialectOf(env.DB) === "mysql") {
		return { ok: false, error: "approve_send is unavailable on MySQL: this deployment lacks the delivery uniqueness constraint that makes an approval single-send; use the web review page", code: "unsupported_dialect" };
	}
	const [approval] = await getDb(env)
		.select({
			mailboxId: agentSendApprovals.mailboxId,
			userId: agentSendApprovals.userId,
			requestKeyId: agentSendApprovals.requestKeyId,
		})
		.from(agentSendApprovals)
		.where(eq(agentSendApprovals.id, input.approvalId))
		.limit(1);
	// 4. Own drafts only: the stored creating key must be this key's server-side id. A request made
	// in the web UI has no key on it, and another key's request names that key, so both are "not found"
	// rather than being reported as existing.
	if (!approval || approval.userId !== principal.user.id || approval.mailboxId !== input.mailboxId || approval.requestKeyId !== principal.keyId) {
		return { ok: false, error: "Approval not found", code: "not_found" };
	}

	const record = async (status: string, messageId: string | null) => createAuditLog(env, {
		actorUserId: principal.user.id,
		mailboxId: approval.mailboxId,
		messageId,
		action: "email.approve_send",
		metadata: { approvalId: input.approvalId, keyId: principal.keyId, origin: "mcp", status, messageId, at: new Date().toISOString() },
	});

	try {
		// Idempotent: an approval that is no longer pending returns its current state instead of sending
		// again. Two callers racing on one pending approval are serialised by the conditional update in
		// `confirmAgentSend` (agent_send_approvals `pending` -> `claimed` ... where status = 'pending'
		// returning id), the repo's existing claim/row-lock: only the caller that updates the row sends.
		const result = await confirmAgentSend(env, principal.user, input.approvalId, publicOrigin);
		const messageId = result.messageId ?? null;
		if (result.status === "sent") {
			const status = messageId ? await deliveryStatus(env, messageId) : "sent";
			await record(status, messageId);
			return { ok: true, approvalId: input.approvalId, status, messageId };
		}
		// A decided or in-flight approval is not a refusal: the caller gets the state it settled on
		// (`claimed` from the confirmation that won the race, `queued`/`sent` once that one finishes,
		// `cancelled`) and nothing is sent twice. Only `expired` stays an error, below.
		if (result.status !== "expired") {
			await record(result.status, messageId);
			return { ok: true, approvalId: input.approvalId, status: result.status, messageId };
		}
		await record("expired", messageId);
		return { ok: false, error: "Approval expired", code: "expired", approvalId: input.approvalId, status: "expired" };
	} catch (error) {
		const reason = error instanceof Error ? error.message : "Approval failed";
		// `confirmAgentSend` throws "Approval expired" when it is the call that expired the request.
		if (reason === "Approval expired") {
			await record("expired", null);
			return { ok: false, error: reason, code: "expired", approvalId: input.approvalId, status: "expired" };
		}
		await record("error", null);
		return { ok: false, error: reason, code: "refused", approvalId: input.approvalId };
	}
}

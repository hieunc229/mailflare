import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { agentSendApprovals, messages } from "@/db/schema";
import { confirmAgentSend } from "@/lib/agent/approvals/utils";
import { createAuditLog } from "@/lib/mailboxes/audit";
import type { McpPrincipal } from "./types";

export type ApproveSendOutcome =
	| { ok: true; approvalId: string; status: string; messageId: string | null }
	| { ok: false; error: string; approvalId?: string; status?: string; messageId?: string | null };

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
		return { ok: false, error: "Permission denied" };
	}
	// 2. Per-key flag, off by default: holding a key alone never releases a send.
	if (!principal.canApproveOwnSends) {
		return { ok: false, error: "Permission denied: this key may not approve its own sends" };
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
	// 3. Own drafts only: the stored creating key must be this key's server-side id. A request made
	// in the web UI has no key on it, and another key's request names that key, so both are "not found"
	// rather than being reported as existing.
	if (!approval || approval.userId !== principal.user.id || approval.mailboxId !== input.mailboxId || approval.requestKeyId !== principal.keyId) {
		return { ok: false, error: "Approval not found" };
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
		// Emptying the claim means the caller lost the race or the reviewer already decided; report that
		// state without sending, and never resurrect an expired approval (the page shows it as expired too).
		await record(result.status, messageId);
		return { ok: false, error: `Send was not released: ${result.status}`, approvalId: input.approvalId, status: result.status, messageId };
	} catch (error) {
		const reason = error instanceof Error ? error.message : "Approval failed";
		await record(reason === "Approval expired" ? "expired" : "error", null);
		return { ok: false, error: reason, approvalId: input.approvalId };
	}
}

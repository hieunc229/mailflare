import { and, eq, inArray, ne } from "drizzle-orm";
import type { AppDatabase } from "@/db";
import { isUniqueConstraintError } from "@/lib/database-errors";
import { agentSendApprovals } from "@/db/schema";

// Claim an approval for delivery unless another approval of the same draft is already delivering or
// delivered. MySQL has no partial unique index on (draft_id) for these statuses, so check in code.
export async function claimAgentApproval(db: AppDatabase, approvalId: string, draftId: string): Promise<"claimed" | "not_pending" | "in_progress"> {
	let claimed: { id: string }[];
	try {
		claimed = await db.update(agentSendApprovals).set({ status: "claimed", claimedAt: new Date() })
			.where(and(eq(agentSendApprovals.id, approvalId), eq(agentSendApprovals.status, "pending"))).returning({ id: agentSendApprovals.id });
	} catch (error) {
		// SQLite and PostgreSQL enforce one delivery per draft with a partial unique index.
		if (isUniqueConstraintError(error)) return "in_progress";
		throw error;
	}
	if (!claimed.length) return "not_pending";
	const [other] = await db.select({ id: agentSendApprovals.id }).from(agentSendApprovals)
		.where(and(eq(agentSendApprovals.draftId, draftId), ne(agentSendApprovals.id, approvalId), inArray(agentSendApprovals.status, ["claimed", "sent", "unknown"]))).limit(1);
	if (!other) return "claimed";
	await db.update(agentSendApprovals).set({ status: "pending", claimedAt: null })
		.where(and(eq(agentSendApprovals.id, approvalId), eq(agentSendApprovals.status, "claimed")));
	return "in_progress";
}

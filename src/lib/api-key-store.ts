import { and, eq } from "drizzle-orm";
import type { AppDatabase } from "@/db";
import { agentSendApprovals, apiKeys, mcpKeyMailboxes } from "@/db/schema";
import { recordAuthActivity } from "@/lib/auth/activity";
import { isListedAsAppPassword } from "@/lib/auth/app-password-utils";

/** Persists a key and its mailbox scope. `mailboxIds` may be empty (no scope rows). */
export async function insertApiKeyRow(db: AppDatabase, row: typeof apiKeys.$inferInsert, mailboxIds: string[]): Promise<void> {
	await db.insert(apiKeys).values(row);
	if (mailboxIds.length) await db.insert(mcpKeyMailboxes).values(mailboxIds.map((mailboxId) => ({ keyId: row.id, mailboxId })));
}

/** Cancels the key's pending send approvals and deletes it; an app password's revocation is recorded as account activity. */
export async function revokeApiKey(db: AppDatabase, env: CloudflareEnv, input: { id: string; userId: string; kind: string; scopes: string; request: Request }): Promise<void> {
	await db.update(agentSendApprovals).set({ status: "cancelled" }).where(and(eq(agentSendApprovals.requestKeyId, input.id), eq(agentSendApprovals.status, "pending")));
	await db.delete(apiKeys).where(and(eq(apiKeys.id, input.id), eq(apiKeys.userId, input.userId)));
	if (isListedAsAppPassword(input)) await recordAuthActivity(env, { action: "auth.app_password_revoked", userId: input.userId, request: input.request });
}

import { and, eq, lt } from "drizzle-orm";
import { getDb } from "@/db";
import { messageActionUndoClaims } from "@/db/schema";
import { isUniqueConstraintError } from "@/lib/database-errors";

/** Opportunistic and scheduled cleanup of spent/expired single-use undo tokens. */
export async function pruneExpiredMessageActionUndoClaims(env: CloudflareEnv, now = new Date()): Promise<void> {
	await getDb(env).delete(messageActionUndoClaims).where(lt(messageActionUndoClaims.expiresAt, now));
}

/**
 * Atomically consumes a token nonce: exactly one insert wins. The claim is
 * written before the restore, so a crash in between reports an expired undo
 * rather than risking a replay.
 */
export async function claimMessageActionUndoToken(
	env: CloudflareEnv,
	input: { nonce: string; userId: string; expiresAt: Date },
): Promise<"claimed" | "duplicate"> {
	const db = getDb(env);
	await pruneExpiredMessageActionUndoClaims(env, new Date());
	try {
		await db.insert(messageActionUndoClaims).values({
			nonce: input.nonce,
			userId: input.userId,
			expiresAt: input.expiresAt,
		});
		return "claimed";
	} catch (error) {
		if (isUniqueConstraintError(error)) return "duplicate";
		throw error;
	}
}

/** A claim is released only when the request failed before returning a settled outcome. */
export async function releaseMessageActionUndoClaim(
	env: CloudflareEnv,
	input: { nonce: string; userId: string },
): Promise<void> {
	await getDb(env).delete(messageActionUndoClaims).where(and(
		eq(messageActionUndoClaims.nonce, input.nonce),
		eq(messageActionUndoClaims.userId, input.userId),
	));
}

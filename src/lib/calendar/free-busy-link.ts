import { and, eq } from "drizzle-orm";
import type { AppDatabase } from "@/db";
import { apiKeys } from "@/db/schema";
import { generateApiKey, scopesToJson } from "@/lib/api-keys";
import { authenticateApiKeyValue } from "@/lib/api/key-auth";
import { freeBusyKeyId } from "./free-busy-key-id";

/** The one scope of a publish key (spec F9 D-11). It is never offered by the general key route, so this module is the only way to get one. */
export const FREEBUSY_SCOPE = "calendar:freebusy";

/**
 * A user's publish key has an id of its own making (`freeBusyKeyId`), so "one per user" is the primary key's job: two requests turning it on at once
 * cannot both insert (no schema change, no lock); `enableFreeBusyLink` tells the winner from the loser on every database.
 */
export { freeBusyKeyId };

export async function getFreeBusyLink(db: AppDatabase, userId: string): Promise<{ enabled: false } | { enabled: true; createdAt: Date; lastUsedAt: Date | null }> {
	const [row] = await db.select({ createdAt: apiKeys.createdAt, lastUsedAt: apiKeys.lastUsedAt, scopes: apiKeys.scopes }).from(apiKeys).where(and(eq(apiKeys.id, freeBusyKeyId(userId)), eq(apiKeys.userId, userId))).limit(1);
	return row ? { enabled: true, createdAt: row.createdAt, lastUsedAt: row.lastUsedAt } : { enabled: false };
}

/** `created: true` carries the secret, which is stored only as a hash and cannot be shown again; `false` means the link was already on. */
export async function enableFreeBusyLink(db: AppDatabase, userId: string): Promise<{ created: true; key: string } | { created: false }> {
	const issued = await generateApiKey();
	const [made] = await db.insert(apiKeys).values({
		id: freeBusyKeyId(userId), userId, name: "Published free/busy", prefix: issued.prefix, keyHash: issued.hash, keySha256: issued.sha256, scopes: scopesToJson([FREEBUSY_SCOPE]), mailboxScopeEnabled: true,
	}).onConflictDoNothing().returning({ id: apiKeys.id, keySha256: apiKeys.keySha256 });
	// MySQL has no RETURNING: its shim reads the row back by id, so a request that lost the race can be handed the winner's row. Only the stored hash says whose secret it is.
	return made?.keySha256 === issued.sha256 ? { created: true, key: issued.fullKey } : { created: false };
}

/** True when a link was removed. */
export async function disableFreeBusyLink(db: AppDatabase, userId: string): Promise<boolean> {
	const removed = await db.delete(apiKeys).where(and(eq(apiKeys.id, freeBusyKeyId(userId)), eq(apiKeys.userId, userId))).returning({ id: apiKeys.id });
	return removed.length > 0;
}

/**
 * The owner of a publish URL, or null. Every reason for refusing (no such key, other scopes, a disabled account, Calendar switched off)
 * is the same null, so the answer cannot be used to probe accounts. The scope must be exactly this one: hasScope would let a "*" key through.
 */
export async function authenticateFreeBusyKey(env: CloudflareEnv, secret: string): Promise<{ userId: string; keyId: string } | null> {
	// Exact scope: hasScope would let a "*" key through. Checked before the key is recorded as used.
	const key = await authenticateApiKeyValue(env, secret, { scope: FREEBUSY_SCOPE, accept: ({ scopes, user }) => scopes.length === 1 && scopes[0] === FREEBUSY_SCOPE && user.calendarEnabled });
	if (!key) return null;
	return { userId: key.userId, keyId: key.keyId };
}

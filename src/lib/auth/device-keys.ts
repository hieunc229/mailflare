import { and, desc, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { apiKeys, pushDevices } from "@/db/schema";
import { generateApiKey, scopesToJson } from "@/lib/api-keys";
import { newId } from "@/lib/ids";

/**
 * Device keys: what a mobile app receives from `/api/auth/device`. Each is a
 * `jmap`-scoped API key named after the device, with no mailbox restriction
 * (access follows `mailbox_access` live). They never carry admin scopes and
 * are revoked with the user's sessions.
 */
export async function createDeviceKey(env: CloudflareEnv, userId: string, deviceName: string): Promise<{ id: string; key: string }> {
	const { fullKey, prefix, hash, sha256 } = await generateApiKey();
	const id = newId("key");
	await getDb(env).insert(apiKeys).values({
		id,
		kind: "device",
		userId,
		name: deviceName.slice(0, 100),
		prefix,
		keyHash: hash,
		keySha256: sha256,
		scopes: scopesToJson(["jmap"]),
		mailboxScopeEnabled: false,
	});
	return { id, key: fullKey };
}

export async function listDeviceKeys(env: CloudflareEnv, userId: string) {
	const db = getDb(env);
	const keys = await db
		.select({ id: apiKeys.id, name: apiKeys.name, createdAt: apiKeys.createdAt, lastUsedAt: apiKeys.lastUsedAt })
		.from(apiKeys)
		.where(and(eq(apiKeys.userId, userId), eq(apiKeys.kind, "device")))
		.orderBy(desc(apiKeys.createdAt));
	const push = await db.select({ apiKeyId: pushDevices.apiKeyId }).from(pushDevices).where(eq(pushDevices.userId, userId));
	const withPush = new Set(push.map((row) => row.apiKeyId));
	return keys.map((key) => ({ ...key, pushEnabled: withPush.has(key.id) }));
}

/** Returns whether a key was removed. Its push registrations cascade. */
export async function revokeDeviceKey(env: CloudflareEnv, userId: string, keyId: string): Promise<boolean> {
	const db = getDb(env);
	const removed = await db
		.delete(apiKeys)
		.where(and(eq(apiKeys.id, keyId), eq(apiKeys.userId, userId), eq(apiKeys.kind, "device")))
		.returning({ id: apiKeys.id });
	return removed.length > 0;
}

export async function revokeAllDeviceKeys(env: CloudflareEnv, userId: string): Promise<void> {
	await getDb(env).delete(apiKeys).where(and(eq(apiKeys.userId, userId), eq(apiKeys.kind, "device")));
}

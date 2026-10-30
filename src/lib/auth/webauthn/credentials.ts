import { and, eq, lt } from "drizzle-orm";
import { isoBase64URL } from "@simplewebauthn/server/helpers";
import type { WebAuthnCredential } from "@simplewebauthn/server";
import { getDb } from "@/db";
import { passkeyCredentials } from "@/db/schema";
import { newId } from "@/lib/ids";
import { hashSessionToken } from "@/lib/auth/session";

export type StoredPasskey = typeof passkeyCredentials.$inferSelect;

export function credentialIdHash(credentialId: string): Promise<string> {
	return hashSessionToken(credentialId);
}

export async function listPasskeys(env: CloudflareEnv, userId: string): Promise<StoredPasskey[]> {
	const db = getDb(env);
	return db.select().from(passkeyCredentials).where(eq(passkeyCredentials.userId, userId));
}

export async function countPasskeys(env: CloudflareEnv, userId: string): Promise<number> {
	const rows = await listPasskeys(env, userId);
	return rows.length;
}

export async function findPasskeyByCredentialId(env: CloudflareEnv, credentialId: string): Promise<StoredPasskey | null> {
	const db = getDb(env);
	const [row] = await db
		.select()
		.from(passkeyCredentials)
		.where(eq(passkeyCredentials.credentialHash, await credentialIdHash(credentialId)))
		.limit(1);
	return row ?? null;
}

export function toWebAuthnCredential(passkey: StoredPasskey): WebAuthnCredential {
	return {
		id: passkey.credentialId,
		publicKey: isoBase64URL.toBuffer(passkey.publicKey),
		counter: passkey.counter,
		transports: passkey.transports ? passkey.transports.split(",").filter(Boolean) : undefined,
	};
}

export async function buildPasskeyRow(
	env: CloudflareEnv,
	input: {
		userId: string;
		credentialId: string;
		publicKey: Uint8Array;
		counter: number;
		deviceType: string;
		backedUp: boolean;
		aaguid?: string | null;
		transports?: string[];
		name: string;
	},
): Promise<typeof passkeyCredentials.$inferInsert> {
	return {
		id: newId("pk"),
		userId: input.userId,
		credentialId: input.credentialId,
		credentialHash: await credentialIdHash(input.credentialId),
		publicKey: isoBase64URL.fromBuffer(Uint8Array.from(input.publicKey)),
		counter: input.counter,
		transports: input.transports?.length ? input.transports.join(",") : null,
		deviceType: input.deviceType,
		backedUp: input.backedUp,
		aaguid: input.aaguid ?? null,
		// An empty name is intentional: the UI shows the passkey provider or a
		// dated default until the user renames it. The native credential manager
		// controls its own label, which WebAuthn cannot read or set.
		name: input.name.trim(),
	};
}

export async function savePasskey(
	env: CloudflareEnv,
	input: Parameters<typeof buildPasskeyRow>[1],
): Promise<StoredPasskey> {
	const db = getDb(env);
	const [row] = await db.insert(passkeyCredentials).values(await buildPasskeyRow(env, input)).returning();
	return row;
}

/**
 * Updates the signature counter. A credential whose counter went backwards is
 * treated as cloned and the caller must reject the assertion.
 */
export async function recordPasskeyUse(env: CloudflareEnv, passkey: StoredPasskey, newCounter: number): Promise<boolean> {
	if (passkey.counter > 0 && newCounter <= passkey.counter) return false;
	const db = getDb(env);
	const rows = await db
		.update(passkeyCredentials)
		.set({ counter: newCounter, lastUsedAt: new Date() })
		.where(and(eq(passkeyCredentials.id, passkey.id), newCounter > passkey.counter ? lt(passkeyCredentials.counter, newCounter) : eq(passkeyCredentials.counter, passkey.counter)))
		.returning({ id: passkeyCredentials.id });
	return rows.length > 0;
}

export async function renamePasskey(env: CloudflareEnv, userId: string, id: string, name: string): Promise<boolean> {
	const db = getDb(env);
	const rows = await db
		.update(passkeyCredentials)
		.set({ name })
		.where(and(eq(passkeyCredentials.id, id), eq(passkeyCredentials.userId, userId)))
		.returning({ id: passkeyCredentials.id });
	return rows.length > 0;
}

export async function deletePasskey(env: CloudflareEnv, userId: string, id: string): Promise<boolean> {
	const db = getDb(env);
	const rows = await db
		.delete(passkeyCredentials)
		.where(and(eq(passkeyCredentials.id, id), eq(passkeyCredentials.userId, userId)))
		.returning({ id: passkeyCredentials.id });
	return rows.length > 0;
}

import { and, eq, isNull, type SQL } from "drizzle-orm";
import type { AppDatabase } from "@/db";
import { apiKeys } from "@/db/schema";
import { apiKeyLookupPrefix, hashApiKey, timingSafeEqualText, verifyApiKey } from "@/lib/api-keys";

type ApiKeyRecord = typeof apiKeys.$inferSelect;
type ApiKeyKind = ApiKeyRecord["kind"];

/** Long enough that a client polling about once a minute hits a warm isolate. */
const CACHE_TTL_MS = 120_000;
const CACHE_MAX = 200;

type CacheEntry = { keyId: string; expiresAt: number };
const verifiedByDigest = new Map<string, CacheEntry>();

export function clearApiKeyVerificationCache(): void {
	verifiedByDigest.clear();
}

function cacheKey(digest: string, kind: ApiKeyKind | undefined): string {
	return kind ? `${kind}\0${digest}` : digest;
}

function remember(digest: string, kind: ApiKeyKind | undefined, keyId: string): void {
	const id = cacheKey(digest, kind);
	if (verifiedByDigest.size >= CACHE_MAX && !verifiedByDigest.has(id)) {
		const oldest = verifiedByDigest.keys().next().value;
		if (oldest !== undefined) verifiedByDigest.delete(oldest);
	}
	verifiedByDigest.delete(id);
	verifiedByDigest.set(id, { keyId, expiresAt: Date.now() + CACHE_TTL_MS });
}

function recall(digest: string, kind: ApiKeyKind | undefined): string | null {
	const id = cacheKey(digest, kind);
	const entry = verifiedByDigest.get(id);
	if (!entry) return null;
	if (entry.expiresAt <= Date.now()) {
		verifiedByDigest.delete(id);
		return null;
	}
	verifiedByDigest.delete(id);
	verifiedByDigest.set(id, entry);
	return entry.keyId;
}

function forget(digest: string, kind: ApiKeyKind | undefined): void {
	verifiedByDigest.delete(cacheKey(digest, kind));
}

function whereMatch(match: SQL, kind: ApiKeyKind | undefined) {
	return kind ? and(match, eq(apiKeys.kind, kind)) : match;
}

async function readKey(db: AppDatabase, match: SQL, kind: ApiKeyKind | undefined): Promise<ApiKeyRecord | null> {
	const [row] = await db.select().from(apiKeys).where(whereMatch(match, kind)).limit(1);
	return row ?? null;
}

/**
 * Resolve a presented API key or app password to its row.
 *
 * Keys with `key_sha256` are found by that hash and compared in constant time,
 * which fits the Workers free-tier CPU budget. Rows without it still use bcrypt,
 * and a match stores the SHA-256 so the next request takes the cheap path.
 * A short in-isolate cache remembers successful digests; the row is loaded
 * again so a revoked key stops working on the next request.
 */
export async function findApiKeyForSecret(db: AppDatabase, secret: string, options?: { kind?: ApiKeyKind }): Promise<ApiKeyRecord | null> {
	const presented = secret.trim();
	if (!presented) return null;
	const kind = options?.kind;
	const digest = await hashApiKey(presented);

	const cachedId = recall(digest, kind);
	if (cachedId) {
		const cached = await readKey(db, eq(apiKeys.id, cachedId), kind);
		if (cached?.keySha256 && timingSafeEqualText(cached.keySha256, digest)) return cached;
		forget(digest, kind);
	}

	const hashed = await readKey(db, eq(apiKeys.keySha256, digest), kind);
	if (hashed?.keySha256 && timingSafeEqualText(hashed.keySha256, digest)) {
		remember(digest, kind, hashed.id);
		return hashed;
	}

	const legacyMatch = and(eq(apiKeys.prefix, apiKeyLookupPrefix(presented)), isNull(apiKeys.keySha256));
	if (!legacyMatch) return null;
	const legacy = await db.select().from(apiKeys).where(whereMatch(legacyMatch, kind));
	for (const candidate of legacy) {
		if (!verifyApiKey(presented, candidate.keyHash)) continue;
		await db.update(apiKeys).set({ keySha256: digest }).where(and(eq(apiKeys.id, candidate.id), isNull(apiKeys.keySha256)));
		remember(digest, kind, candidate.id);
		return { ...candidate, keySha256: digest };
	}
	return null;
}

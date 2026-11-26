import { and, eq, lt, or, isNull } from "drizzle-orm";
import { getDb } from "@/db";
import { apiKeys, mcpKeyMailboxes, users } from "@/db/schema";
import { parseScopes } from "@/lib/api-keys";
import { findApiKeyForSecret } from "@/lib/api/find-api-key";
import type { ApiAuthResult } from "@/lib/api/key-auth-types";
import { ADMIN_API_KEY_SCOPES } from "@/lib/api/scopes";
import { getClientIp } from "@/lib/auth/client-ip";

const LAST_USED_WRITE_INTERVAL_MS = 60_000;
const ADMIN_SCOPES = new Set<string>(ADMIN_API_KEY_SCOPES);

export type ApiKeyUsage = { protocol: string; ip: string | null };

/**
 * Resolve an API key to its user and scopes. Framework-free so it can run in
 * `worker.ts` as well as route handlers. `lastUsedAt` is refreshed at most
 * once a minute per key, since protocol clients make many small calls; `usage`
 * is stored with it. `kind` and `scope` narrow what counts as a match, and a
 * key refused for them is not recorded as used.
 */
export async function authenticateApiKeyValue(env: CloudflareEnv, key: string, options?: { kind?: ApiAuthResult["keyKind"]; scope?: string; usage?: ApiKeyUsage }): Promise<ApiAuthResult | null> {
	const trimmed = key.trim();
	if (!trimmed) return null;
	// Authentication reads the primary: a lagging read replica could still honour a key that was just revoked.
	const db = getDb({ DB: env.DB_PRIMARY ?? env.DB });
	const candidate = await findApiKeyForSecret(db, trimmed, { kind: options?.kind });
	if (!candidate) return null;
	if (options?.scope && !parseScopes(candidate.scopes).includes(options.scope)) return null;
	const [user] = await db.select().from(users).where(eq(users.id, candidate.userId)).limit(1);
	if (!user || user.disabled) return null;

	const stale = new Date(Date.now() - LAST_USED_WRITE_INTERVAL_MS);
	await db
		.update(apiKeys)
		.set({ lastUsedAt: new Date(), ...(options?.usage ? { lastUsedProtocol: options.usage.protocol, lastUsedIp: options.usage.ip } : {}) })
		.where(and(eq(apiKeys.id, candidate.id), or(isNull(apiKeys.lastUsedAt), lt(apiKeys.lastUsedAt, stale))));

	const scopes = parseScopes(candidate.scopes);
	const allowed = candidate.mailboxScopeEnabled
		? await db.select({ mailboxId: mcpKeyMailboxes.mailboxId }).from(mcpKeyMailboxes).where(eq(mcpKeyMailboxes.keyId, candidate.id))
		: null;
	return { keyId: candidate.id, keyKind: candidate.kind, userId: user.id, email: user.email, scopes: scopes.some((scope) => ADMIN_SCOPES.has(scope)) ? scopes.filter((scope) => ADMIN_SCOPES.has(scope)) : scopes, mailboxIds: allowed?.map((row) => row.mailboxId) ?? null, user };
}

/**
 * JMAP clients send the key either as a Bearer token or as the password of
 * HTTP Basic auth (the username is ignored; the key identifies the account).
 * Pass `protocol` to record how the key was used (see `ApiKeyUsage`).
 */
export async function authenticateApiRequest(env: CloudflareEnv, request: Request, protocol?: string): Promise<ApiAuthResult | null> {
	const authorization = request.headers.get("Authorization") ?? "";
	const options = protocol ? { usage: { protocol, ip: getClientIp(request) } } : undefined;
	if (authorization.startsWith("Bearer ")) return authenticateApiKeyValue(env, authorization.slice(7), options);
	if (authorization.startsWith("Basic ")) {
		let decoded = "";
		try {
			decoded = atob(authorization.slice(6).trim());
		} catch {
			return null;
		}
		const separator = decoded.indexOf(":");
		return authenticateApiKeyValue(env, separator >= 0 ? decoded.slice(separator + 1) : decoded, options);
	}
	return null;
}

export function hasScope(scopes: string[], required: string): boolean {
	return scopes.includes(required) || scopes.includes("*");
}

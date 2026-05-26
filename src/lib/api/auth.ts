import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { apiKeys, users } from "@/db/schema";
import { verifyApiKey, parseScopes } from "@/lib/api-keys";

export type ApiAuthResult = {
	userId: string;
	email: string;
	scopes: string[];
};

export async function authenticateApiKey(
	env: CloudflareEnv,
	authorization: string | null,
): Promise<ApiAuthResult | null> {
	if (!authorization?.startsWith("Bearer ")) return null;
	const key = authorization.slice(7).trim();
	if (!key) return null;

	const prefix = key.slice(0, 12);
	const db = getDb(env);
	const candidates = await db.select().from(apiKeys).where(eq(apiKeys.prefix, prefix));

	for (const candidate of candidates) {
		if (!verifyApiKey(key, candidate.keyHash)) continue;
		const [user] = await db.select().from(users).where(eq(users.id, candidate.userId)).limit(1);
		if (!user) continue;

		await db
			.update(apiKeys)
			.set({ lastUsedAt: new Date() })
			.where(eq(apiKeys.id, candidate.id));

		return {
			userId: user.id,
			email: user.email,
			scopes: parseScopes(candidate.scopes),
		};
	}
	return null;
}

export function requireScope(scopes: string[], required: string): boolean {
	return scopes.includes(required) || scopes.includes("*");
}

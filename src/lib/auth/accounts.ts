import { and, eq, gt, inArray } from "drizzle-orm";
import { getDb } from "@/db";
import { sessions, users } from "@/db/schema";
import { hashSessionToken, SESSION_COOKIE } from "@/lib/auth/session";

/**
 * Browser-wide set of signed-in accounts. Holds session tokens only; the
 * cookie is httpOnly so scripts cannot read it. A token placed here by a client
 * is useless unless it is already a live session in the database, so the
 * cookie needs no signature of its own.
 */
export const ACCOUNTS_COOKIE = "ep_accounts";
export const MAX_ACCOUNTS = 5;
const COOKIE_MAX_AGE = 60 * 60 * 24 * 30;

export function parseAccountTokens(value: string | undefined): string[] {
	if (!value) return [];
	return Array.from(new Set(value.split(".").filter(Boolean))).slice(0, MAX_ACCOUNTS);
}

export function serializeAccountTokens(tokens: string[]): string {
	return tokens.join(".");
}

export function cookieOptions(maxAge = COOKIE_MAX_AGE) {
	return {
		httpOnly: true,
		secure: process.env.NODE_ENV === "production",
		sameSite: "lax" as const,
		path: "/",
		maxAge,
	};
}

export type AccountSummary = {
	userId: string;
	email: string;
	name: string;
	hasAvatar: boolean;
	avatarKey: string | null;
	token: string;
};

/** Resolve tokens to live, enabled users; dead tokens are dropped. */
export async function resolveAccounts(env: CloudflareEnv, tokens: string[]): Promise<AccountSummary[]> {
	if (tokens.length === 0) return [];
	const db = getDb(env);
	const hashes = await Promise.all(tokens.map((token) => hashSessionToken(token)));
	const rows = await db
		.select({ tokenHash: sessions.tokenHash, user: users })
		.from(sessions)
		.innerJoin(users, eq(users.id, sessions.userId))
		.where(and(inArray(sessions.tokenHash, hashes), gt(sessions.expiresAt, new Date())));
	const byHash = new Map(rows.map((row) => [row.tokenHash, row.user]));
	const accounts: AccountSummary[] = [];
	for (let i = 0; i < tokens.length; i++) {
		const user = byHash.get(hashes[i]);
		if (!user || user.disabled) continue;
		accounts.push({
			userId: user.id,
			email: user.email,
			name: user.name,
			hasAvatar: !!user.avatarKey,
			avatarKey: user.avatarKey,
			token: tokens[i],
		});
	}
	return accounts;
}

/** Add `token` to the set, replacing older entries for the same user. */
export async function addAccountToken(
	env: CloudflareEnv,
	existing: string | undefined,
	token: string,
	previousActive?: string,
): Promise<string> {
	// The session being replaced may predate the accounts cookie; keep it.
	const current = await resolveAccounts(env, parseAccountTokens(existing).concat(previousActive ?? []));
	const [added] = await resolveAccounts(env, [token]);
	const kept = current.filter((account) => account.userId !== added?.userId).map((account) => account.token);
	return serializeAccountTokens([...kept, token].slice(-MAX_ACCOUNTS));
}

/**
 * Record a fresh login in the accounts cookie. Switching accounts is a
 * convenience, so a failure here must never block the login itself.
 */
export async function rememberLogin(
	env: CloudflareEnv,
	response: { cookies: { set: (name: string, value: string, options: ReturnType<typeof cookieOptions>) => unknown } },
	existing: string | undefined,
	token: string,
	previousActive?: string,
): Promise<void> {
	try {
		response.cookies.set(ACCOUNTS_COOKIE, await addAccountToken(env, existing, token, previousActive), cookieOptions());
	} catch (error) {
		console.error("Could not record signed-in account", error);
	}
}

export { SESSION_COOKIE };

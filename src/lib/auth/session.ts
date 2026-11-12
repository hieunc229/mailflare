import { and, eq, gt, ne } from "drizzle-orm";
import { revokeAllDeviceKeys } from "@/lib/auth/device-keys";
import { newId } from "@/lib/ids";
import { getDb } from "@/db";
import { sessions, users } from "@/db/schema";

export const SESSION_COOKIE = "ep_session";
const SESSION_DAYS = 30;

export function generateSessionToken(): string {
	return newId("sess");
}

export async function hashSessionToken(token: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
	return Array.from(new Uint8Array(digest))
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
}

export async function createSession(env: CloudflareEnv, userId: string): Promise<string> {
	const db = getDb(env);
	const token = generateSessionToken();
	const tokenHash = await hashSessionToken(token);
	const expiresAt = new Date(Date.now() + SESSION_DAYS * 86_400_000);

	await db.insert(sessions).values({
		id: newId(),
		userId,
		tokenHash,
		expiresAt,
	});
	await db.update(users).set({ lastSignInAt: new Date() }).where(eq(users.id, userId));

	return token;
}

export async function getUserFromSession(
	env: CloudflareEnv,
	token: string | undefined,
): Promise<typeof users.$inferSelect | null> {
	const session = await getSessionFromToken(env, token);
	if (!session) return null;
	// Same reason as below: `disabled` must be seen as soon as another admin writes it.
	const db = getDb({ DB: env.DB_PRIMARY ?? env.DB });
	const [user] = await db.select().from(users).where(eq(users.id, session.userId)).limit(1);
	return user ?? null;
}

export async function getSessionFromToken(
	env: CloudflareEnv,
	token: string | undefined,
): Promise<typeof sessions.$inferSelect | null> {
	if (!token) return null;
	// Authentication always reads the primary: a read-replica session could still honor a
	// session another device just revoked — no bookmark covers other clients' writes.
	const db = getDb({ DB: env.DB_PRIMARY ?? env.DB });
	const tokenHash = await hashSessionToken(token);
	const [session] = await db
		.select()
		.from(sessions)
		.where(and(eq(sessions.tokenHash, tokenHash), gt(sessions.expiresAt, new Date())))
		.limit(1);
	return session ?? null;
}

export async function deleteSession(env: CloudflareEnv, token: string): Promise<void> {
	const db = getDb(env);
	const tokenHash = await hashSessionToken(token);
	await db.delete(sessions).where(eq(sessions.tokenHash, tokenHash));
}

/**
 * Sign the user out everywhere, optionally keeping the session that made the
 * request. Used after a password change or reset and when MFA is switched on.
 */
/**
 * Signs the user out everywhere: every session (but `keepToken`'s) and every
 * mobile device key, so a password change or "sign out everywhere" also
 * disconnects the apps.
 */
export async function deleteUserSessions(env: CloudflareEnv, userId: string, keepToken?: string): Promise<void> {
	const db = getDb(env);
	await revokeAllDeviceKeys(env, userId);
	if (keepToken) {
		const keepHash = await hashSessionToken(keepToken);
		await db.delete(sessions).where(and(eq(sessions.userId, userId), ne(sessions.tokenHash, keepHash)));
		return;
	}
	await db.delete(sessions).where(eq(sessions.userId, userId));
}

/** The session token a request carries, from the Bearer header or the cookie. */
export function getSessionTokenFromRequestHeaders(request: Request): string | undefined {
	const authorization = request.headers.get("Authorization");
	if (authorization?.startsWith("Bearer ")) return authorization.slice(7).trim() || undefined;
	const cookie = request.headers.get("Cookie") ?? "";
	const match = cookie.match(new RegExp(`(?:^|;\\s*)${SESSION_COOKIE}=([^;]+)`));
	return match ? decodeURIComponent(match[1]) : undefined;
}

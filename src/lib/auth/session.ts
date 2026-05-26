import { eq, gt } from "drizzle-orm";
import bcrypt from "bcryptjs";
import { newId } from "@/lib/ids";
import { getDb } from "@/db";
import { sessions, users } from "@/db/schema";

export const SESSION_COOKIE = "ep_session";
const SESSION_DAYS = 30;

export function generateSessionToken(): string {
	return newId("sess");
}

export function hashSessionToken(token: string): string {
	return bcrypt.hashSync(token, 10);
}

export function verifySessionToken(token: string, hash: string): boolean {
	return bcrypt.compareSync(token, hash);
}

export async function createSession(env: CloudflareEnv, userId: string): Promise<string> {
	const db = getDb(env);
	const token = generateSessionToken();
	const tokenHash = hashSessionToken(token);
	const expiresAt = new Date();
	expiresAt.setDate(expiresAt.getDate() + SESSION_DAYS);

	await db.insert(sessions).values({
		id: newId(),
		userId,
		tokenHash,
		expiresAt,
	});

	return token;
}

export async function getUserFromSession(
	env: CloudflareEnv,
	token: string | undefined,
): Promise<typeof users.$inferSelect | null> {
	if (!token) return null;
	const db = getDb(env);
	const rows = await db.select().from(sessions).where(gt(sessions.expiresAt, new Date()));
	for (const row of rows) {
		if (verifySessionToken(token, row.tokenHash)) {
			const [user] = await db.select().from(users).where(eq(users.id, row.userId)).limit(1);
			return user ?? null;
		}
	}
	return null;
}

export async function deleteSession(env: CloudflareEnv, token: string): Promise<void> {
	const db = getDb(env);
	const rows = await db.select().from(sessions).where(gt(sessions.expiresAt, new Date()));
	for (const row of rows) {
		if (verifySessionToken(token, row.tokenHash)) {
			await db.delete(sessions).where(eq(sessions.id, row.id));
		}
	}
}

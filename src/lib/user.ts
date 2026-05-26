import { eq, desc, and } from "drizzle-orm";
import { getDb } from "@/db";
import { messages, domains, mailboxes } from "@/db/schema";

export async function listMessagesForUser(
	env: CloudflareEnv,
	userId: string,
	options?: { direction?: "inbound" | "outbound"; limit?: number },
) {
	const db = getDb(env);
	const limit = options?.limit ?? 50;
	const conditions = [eq(messages.userId, userId)];
	if (options?.direction) {
		conditions.push(eq(messages.direction, options.direction));
	}
	return db
		.select()
		.from(messages)
		.where(and(...conditions))
		.orderBy(desc(messages.createdAt))
		.limit(limit);
}

export async function listMailboxesForUser(env: CloudflareEnv, userId: string) {
	const db = getDb(env);
	return db.select().from(mailboxes).where(eq(mailboxes.userId, userId));
}

export async function userHasMailboxes(env: CloudflareEnv, userId: string): Promise<boolean> {
	const db = getDb(env);
	const [row] = await db.select({ id: mailboxes.id }).from(mailboxes).where(eq(mailboxes.userId, userId)).limit(1);
	return !!row;
}

export async function hasPrimaryDomain(env: CloudflareEnv): Promise<boolean> {
	const db = getDb(env);
	const [row] = await db.select({ id: domains.id }).from(domains).limit(1);
	return !!row;
}

export async function getPrimaryDomain(env: CloudflareEnv) {
	const db = getDb(env);
	const [row] = await db.select().from(domains).limit(1);
	return row ?? null;
}

export async function getMailboxForUser(env: CloudflareEnv, userId: string, mailboxId: string) {
	const db = getDb(env);
	const [row] = await db
		.select()
		.from(mailboxes)
		.where(and(eq(mailboxes.id, mailboxId), eq(mailboxes.userId, userId)))
		.limit(1);
	return row ?? null;
}

export async function markMessageAsRead(env: CloudflareEnv, userId: string, messageId: string) {
	const db = getDb(env);
	const [message] = await db
		.select()
		.from(messages)
		.where(eq(messages.id, messageId))
		.limit(1);
	if (!message || message.userId !== userId) return false;
	await db
		.update(messages)
		.set({ read: true })
		.where(eq(messages.id, messageId));
	return true;
}

export async function updateMessageStatus(
	env: CloudflareEnv,
	userId: string,
	messageId: string,
	status: string,
) {
	const db = getDb(env);
	const [message] = await db
		.select()
		.from(messages)
		.where(eq(messages.id, messageId))
		.limit(1);
	if (!message || message.userId !== userId) return false;
	await db
		.update(messages)
		.set({ status })
		.where(eq(messages.id, messageId));
	return true;
}

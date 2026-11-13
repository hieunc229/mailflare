import { and, asc, eq, or, sql } from "drizzle-orm";
import type { getDb } from "@/db";
import { contacts } from "@/db/schema";
import { escapeLike, insensitiveLike } from "@/db/sql";
import { getContactId } from "@/lib/contacts/utils";

type Db = ReturnType<typeof getDb>;

export const CONTACTS_LIST_MAX_LIMIT = 500;
export const CONTACTS_LIST_DEFAULT_LIMIT = 200;

export function parseContactsLimit(value: string | null): number {
	if (value === null) return CONTACTS_LIST_DEFAULT_LIMIT;
	const parsed = Number(value);
	if (!Number.isInteger(parsed) || parsed < 1) return CONTACTS_LIST_DEFAULT_LIMIT;
	return Math.min(parsed, CONTACTS_LIST_MAX_LIMIT);
}

export async function getContactByEmail(db: Db, userId: string, email: string) {
	const [contact] = await db
		.select()
		.from(contacts)
		.where(and(eq(contacts.userId, userId), eq(contacts.email, email)))
		.limit(1);
	return contact ?? null;
}

export async function listContacts(db: Db, input: { userId: string; query: string; limit: number }) {
	const pattern = `%${escapeLike(input.query)}%`;
	const conditions = [eq(contacts.userId, input.userId)];
	if (input.query) {
		conditions.push(
			or(
				insensitiveLike(contacts.email, pattern),
				insensitiveLike(contacts.displayName, pattern),
			)!,
		);
	}
	return db
		.select()
		.from(contacts)
		.where(and(...conditions))
		// Name-less contacts sort by address; lower() keeps ordering consistent across dialects.
		.orderBy(
			asc(sql`lower(coalesce(${contacts.displayName}, ${contacts.email}))`),
			asc(contacts.email),
		)
		.limit(input.limit);
}

export function toContactDetails(contact: Awaited<ReturnType<typeof getContactByEmail>>) {
	if (!contact) return null;
	const { avatarKey, ...details } = contact;
	return { ...details, hasAvatar: !!avatarKey };
}

export async function saveManualContact(
	db: Db,
	input: { userId: string; email: string; displayName?: string | null },
) {
	const existing = await getContactByEmail(db, input.userId, input.email);
	if (existing) {
		const displayName = input.displayName === undefined ? existing.displayName : input.displayName;
		await db
			.update(contacts)
			.set({ displayName, source: "manual" })
			.where(eq(contacts.id, existing.id));
		return { ...existing, displayName, source: "manual" as const };
	}

	const id = getContactId(input.userId, input.email);
	await db.insert(contacts).values({
		id,
		userId: input.userId,
		email: input.email,
		displayName: input.displayName ?? null,
		source: "manual",
	});
	return getContactByEmail(db, input.userId, input.email);
}

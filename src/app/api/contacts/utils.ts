import { and, asc, eq, gt, or, sql } from "drizzle-orm";
import { draftsVisibleTo } from "@/lib/email/draft-access";
import { getEmailAddressList, normalizeEmailAddress } from "@/lib/email/address";
import type { getDb } from "@/db";
import { contactDetails, contacts, messages } from "@/db/schema";
import { escapeLike, insensitiveLike } from "@/db/sql";
import { parseStoredDetails } from "@/lib/contacts/details-utils";
import type { ContactDetailsData } from "@/lib/contacts/details-types";
import { getContactId } from "@/lib/contacts/utils";
import { isMissingTableError } from "@/lib/database-errors";

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

/** The imported phones, addresses and so on of one contact; null when it has none or the migration is not applied yet. */
export async function getContactDetailsData(db: Db, userId: string, email: string): Promise<ContactDetailsData | null> {
	try {
		const [row] = await db.select({ details: contactDetails.details }).from(contactDetails).where(eq(contactDetails.contactId, getContactId(userId, email))).limit(1);
		const details = parseStoredDetails(row?.details);
		return Object.keys(details).length ? details : null;
	} catch (caught) {
		if (isMissingTableError(caught)) return null;
		throw caught;
	}
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

const PAGE_SIZE = 1000;

/**
 * Contacts belong to the user who owns the mailbox, so a shared mailbox's contact list is its creator's whole
 * address book. Anyone who is not that owner may only see contacts whose address appears on mail in this mailbox.
 * Returns the subset of `emails` that does (exact address match).
 */
export async function addressesSeenInMailbox(db: Db, mailboxId: string, emails: string[], viewerUserId: string): Promise<Set<string>> {
	const seen = new Set<string>();
	// Normalised address -> the caller's spelling.
	const wanted = new Map<string, string>();
	for (const email of emails) {
		const key = normalizeEmailAddress(email);
		if (key && !wanted.has(key)) wanted.set(key, email);
	}
	if (wanted.size === 0) return seen;
	// A short list is narrowed in SQL (3 bound parameters per address; D1 allows 100 per statement). A long list
	// cannot be, so the mailbox is read in id order and checked in code; either way every page is one query.
	const narrow = wanted.size <= 25
		? or(...[...wanted.values()].flatMap((email) => {
			const pattern = `%${escapeLike(email)}%`;
			return [eq(messages.fromAddr, email), insensitiveLike(messages.toAddr, pattern), insensitiveLike(messages.ccAddr, pattern)];
		}))
		: undefined;
	let lastId: string | null = null;
	for (;;) {
		const rows: Array<{ id: string; fromAddr: string | null; toAddr: string | null; ccAddr: string | null }> = await db
			.select({ id: messages.id, fromAddr: messages.fromAddr, toAddr: messages.toAddr, ccAddr: messages.ccAddr })
			.from(messages)
			.where(and(eq(messages.mailboxId, mailboxId), draftsVisibleTo(viewerUserId), lastId ? gt(messages.id, lastId) : undefined, narrow))
			.orderBy(asc(messages.id))
			.limit(PAGE_SIZE);
		for (const row of rows) {
			for (const value of [row.fromAddr, row.toAddr, row.ccAddr]) {
				for (const address of getEmailAddressList(value)) {
					const email = wanted.get(address);
					if (email !== undefined) seen.add(email);
				}
			}
		}
		if (seen.size === wanted.size || rows.length < PAGE_SIZE) return seen;
		lastId = rows[rows.length - 1].id;
	}
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

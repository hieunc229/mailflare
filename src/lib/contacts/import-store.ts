import { and, eq, inArray } from "drizzle-orm";
import type { AppDatabase } from "@/db";
import { contactDetails, contacts } from "@/db/schema";
import { isMissingTableError } from "@/lib/database-errors";
import { getPersonalAddresses } from "@/lib/profile/sync";
import { importedContactEmails } from "./details-utils";
import type { ContactImportBody, ContactImportSummary, ExistingContact } from "./import-store-types";
import { chunk, CONTACTS_PER_INSERT, DETAILS_PER_INSERT, parseContactImportCards, planContactImport, SELECT_CHUNK, STATEMENTS_PER_BATCH } from "./import-store-utils";
import { getContactId } from "./utils";

/** The `contact_details` migration has not been applied yet. */
export class ContactDetailsUnavailableError extends Error {}

/**
 * Imports one request's worth of contacts into the address book of `userId` (the mailbox owner). Bounded: at most 100
 * cards and 400 addresses, lookups in chunks of 90, inserts of 8 contacts or 30 detail rows per statement, 50
 * statements per batch. Idempotent: existing contacts are updated only where something differs, so importing the same
 * file again changes nothing. Details are read first, so a database without the table fails before any write.
 */
export async function importContacts(db: AppDatabase, input: { userId: string; body: ContactImportBody }): Promise<ContactImportSummary> {
	const cards = parseContactImportCards(input.body);
	const ids = [...new Set(cards.flatMap(({ contact }) => importedContactEmails(contact.emails).map((email) => getContactId(input.userId, email))))];
	const existing = new Map<string, ExistingContact>();
	const existingDetails = new Map<string, string>();
	for (const part of chunk(ids, SELECT_CHUNK)) {
		const found = await db.select({ id: contacts.id, displayName: contacts.displayName, source: contacts.source, avatarKey: contacts.avatarKey }).from(contacts)
			.where(and(eq(contacts.userId, input.userId), inArray(contacts.id, part)));
		for (const { id, ...row } of found) existing.set(id, row);
		try {
			const details = await db.select({ contactId: contactDetails.contactId, details: contactDetails.details }).from(contactDetails).where(inArray(contactDetails.contactId, part));
			for (const row of details) existingDetails.set(row.contactId, row.details);
		} catch (caught) {
			if (isMissingTableError(caught)) throw new ContactDetailsUnavailableError("Apply pending database migrations to import contacts");
			throw caught;
		}
	}
	// A photo never goes to the user's own profile picture, so own identity addresses are not photo targets.
	const ownAddresses = cards.some((card) => card.hasPhoto) ? await getPersonalAddresses(db, input.userId) : undefined;
	const plan = planContactImport({ userId: input.userId, cards, existing, existingDetails, now: new Date(), ownAddresses });
	const statements = [
		...chunk(plan.contacts, CONTACTS_PER_INSERT).map((rows) => db.insert(contacts).values(rows).onConflictDoNothing()),
		...chunk(plan.detailInserts, DETAILS_PER_INSERT).map((rows) => db.insert(contactDetails).values(rows).onConflictDoNothing()),
		...plan.renames.map((rename) => db.update(contacts).set({ displayName: rename.displayName, source: rename.source }).where(and(eq(contacts.id, rename.id), eq(contacts.userId, input.userId)))),
		...plan.detailUpdates.map((update) => db.update(contactDetails).set({ details: update.details, updatedAt: update.updatedAt }).where(eq(contactDetails.contactId, update.contactId))),
	];
	for (const batch of chunk(statements, STATEMENTS_PER_BATCH)) await db.batch(batch as never);
	return { created: plan.created, updated: plan.updated, unchanged: plan.unchanged, noEmail: plan.noEmail, photoTargets: plan.photoTargets };
}

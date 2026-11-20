import { and, eq, isNull, or } from "drizzle-orm";
import { getDb } from "@/db";
import { contacts, davCards, davCollections } from "@/db/schema";
import { isDavAddress } from "./address";
import { buildCard, isBareCard, removeCardEmail, renameCard } from "./card-edit";
import { parseCard } from "./card-parse";
import { cardUsage, MAX_CARDS } from "./card-store";
import { addressBookCollectionId, etagSeqs } from "./changes";
import { mirrorCardStatements, ownAddresses, unlinkCardStatement } from "./contact-mirror";
import { MAX_CARD_BYTES, MAX_PUT_BODY, staleGuard } from "./writes";
import { isMissingColumnError, isMissingTableError, isUniqueConstraintError } from "@/lib/database-errors";

/**
 * Mailflare-side contact edits reach the address book (spec 8.4): the Contacts API calls these after it saved or before
 * it deletes a contact. Active for every user who has an address book (the row `dav_collections` made by their first
 * CardDAV request), whether or not the administrator's DAV switch is on right now, so the two sides stay in step while it
 * is off. A user without an address book costs one primary-key read per contact edit. A save never throws: the contact
 * edit has already happened, and a card that could not be written is retried by the next edit of that contact. A delete
 * reports whether it may go ahead.
 */

type ContactRef = { id: string; email: string; displayName: string | null; davCardId: string | null };
const ATTEMPTS = 3;

const hex = async (value: string) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)))].map((byte) => byte.toString(16).padStart(2, "0")).join("");

/** Whether the user has an address book. Without the table (migration 0102 not applied yet) nobody has. */
async function hasAddressBook(env: CloudflareEnv, userId: string): Promise<boolean> {
	try {
		const [row] = await getDb(env).select({ id: davCollections.id }).from(davCollections).where(eq(davCollections.id, addressBookCollectionId(userId))).limit(1);
		return !!row;
	} catch (error) {
		if (isMissingTableError(error) || isMissingColumnError(error)) return false;
		throw error;
	}
}

/** Whether another card of this size fits in the user's limits (5000 cards, 20 MB), as a PUT checks them. */
async function fits(env: CloudflareEnv, userId: string, growth: number, newCard: boolean): Promise<boolean> {
	const usage = await cardUsage(env, userId);
	return !(newCard && usage.count >= MAX_CARDS) && usage.bytes + growth <= MAX_CARD_BYTES;
}

/**
 * Change one linked card, redone from a fresh read when a phone changed it in the meantime (the batch starts with the guard
 * of `staleGuard`, so it cannot overwrite that edit). `edit` returns the new body, null to delete the card, or the old body
 * for no change. "missing" when the card is not there.
 */
async function changeCard(env: CloudflareEnv, userId: string, cardId: string, edit: (card: { body: string }) => string | null): Promise<"done" | "missing" | "skipped"> {
	const db = getDb(env);
	const cid = addressBookCollectionId(userId);
	for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
		const [row] = await db.select().from(davCards).where(and(eq(davCards.id, cardId), eq(davCards.userId, userId), eq(davCards.collectionId, cid))).limit(1);
		if (!row) return "missing";
		const seq = (await etagSeqs(env, cid, [cardId])).get(cardId);
		const guard = staleGuard(db, davCards, cid, cardId, userId, { seq: seq ?? null, updatedAt: row.updatedAt });
		const body = edit({ body: row.body });
		let statements: unknown[];
		if (body === null) statements = [...guard, db.delete(davCards).where(and(eq(davCards.id, cardId), eq(davCards.userId, userId))), unlinkCardStatement(db, userId, cardId)];
		else {
			if (body === row.body) return "done";
			const parsed = parseCard(body);
			const size = new TextEncoder().encode(body).byteLength;
			if ("error" in parsed || size > MAX_PUT_BODY || (size > row.size && !(await fits(env, userId, size - row.size, false)))) return "skipped";
			const now = new Date(Math.floor(Date.now() / 1000) * 1000);
			const own = await ownAddresses(env, userId, parsed.emails);
			statements = [
				...guard,
				db.update(davCards).set({ body, fn: parsed.fn, emails: JSON.stringify(parsed.emails), size, updatedAt: now }).where(and(eq(davCards.id, cardId), eq(davCards.userId, userId))),
				...mirrorCardStatements(db, userId, { id: cardId, fn: parsed.fn, emails: parsed.emails, group: parsed.group, own }),
			];
		}
		try {
			await db.batch(statements as never);
			return "done";
		} catch (error) {
			if (!isUniqueConstraintError(error)) throw error;
			// The guard failed: the card changed (or went) since it was read. Read it again.
		}
	}
	return "skipped";
}

/** A new card for a contact that has none, and the link; the contact keeps its own name (the card's FN is that name, or the address). */
async function createCard(env: CloudflareEnv, userId: string, contact: ContactRef): Promise<void> {
	// Own addresses are managed in Mailflare; a card for one would be unlinked by the next rename and made again.
	if (!isDavAddress(contact.email) || (await ownAddresses(env, userId, [contact.email])).has(contact.email)) return;
	const db = getDb(env);
	const cid = addressBookCollectionId(userId);
	for (let attempt = 0; attempt < 2; attempt++) {
		// The first try is named after the contact, so two saves at once (or two seeders) collide on the card's unique UID and one yields.
		const key = (await hex(attempt === 0 ? contact.id : `${contact.id}:${crypto.randomUUID()}`)).slice(0, 32);
		const uid = `mf-${key}`;
		const body = buildCard({ uid, name: contact.displayName, email: contact.email });
		const parsed = parseCard(body);
		if ("error" in parsed) return;
		const size = new TextEncoder().encode(body).byteLength;
		if (!(await fits(env, userId, size, true))) return void console.warn("The address book is full; a contact was not added to it");
		const now = new Date(Math.floor(Date.now() / 1000) * 1000);
		const free = contact.davCardId ? or(isNull(contacts.davCardId), eq(contacts.davCardId, contact.davCardId)) : isNull(contacts.davCardId);
		try {
			await db.batch([
				db.insert(davCards).values({ id: `card_${key}`, userId, collectionId: cid, name: `${uid}.vcf`, uid, body, version: parsed.version, fn: parsed.fn, emails: JSON.stringify(parsed.emails), size, createdAt: now, updatedAt: now }),
				db.update(contacts).set({ davCardId: `card_${key}` }).where(and(eq(contacts.userId, userId), eq(contacts.email, contact.email), free)),
			] as never);
			return;
		} catch (error) {
			if (!isUniqueConstraintError(error)) throw error;
			const [current] = await db.select({ davCardId: contacts.davCardId }).from(contacts).where(and(eq(contacts.userId, userId), eq(contacts.email, contact.email))).limit(1);
			if (current?.davCardId && current.davCardId !== contact.davCardId) return;
		}
	}
}

/**
 * After a contact was created or renamed in Mailflare: a linked card gets the new name (FN and N, every other line kept)
 * and so do the contacts sharing it; a contact without a card (or whose card is gone) gets a new one.
 */
export async function mirrorContactSaved(env: CloudflareEnv, userId: string, contact: ContactRef): Promise<void> {
	try {
		if (!(await hasAddressBook(env, userId))) return;
		const name = contact.displayName?.trim();
		if (contact.davCardId && (await changeCard(env, userId, contact.davCardId, ({ body }) => (name ? renameCard(body, name) : body))) !== "missing") return;
		await createCard(env, userId, contact);
	} catch (error) {
		console.warn("Could not mirror a contact into the address book", error);
	}
}

/**
 * Before a contact is deleted in Mailflare: its EMAIL line leaves its card, and the card goes only when nothing else is left
 * on it (a card with a phone number, a second address of any kind or any other property stays, as the phone stored it).
 * True when the contact may be deleted; false when the card could not be changed (a phone kept changing it), so the caller
 * keeps the contact and the user can try again. A database error is thrown.
 */
export async function mirrorContactDeleted(env: CloudflareEnv, userId: string, contact: { email: string; davCardId: string | null }): Promise<boolean> {
	if (!contact.davCardId || !(await hasAddressBook(env, userId))) return true;
	const result = await changeCard(env, userId, contact.davCardId, ({ body }) => {
		const rest = removeCardEmail(body, contact.email);
		return isBareCard(rest) ? null : rest;
	});
	return result !== "skipped";
}

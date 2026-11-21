import { and, eq, notInArray, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { contacts, mailboxAliases, mailboxes } from "@/db/schema";
import { excluded } from "@/db/sql";
import { getContactId } from "@/lib/contacts/utils";
import { getMailboxDomainAddresses } from "@/lib/mailboxes/domain-addresses";

/**
 * The contacts side of a card (spec 8.1, 8.2). A card owns the name of the contacts it links (`contacts.dav_card_id`);
 * the first card to link an address keeps it. These are statements for the batch of a card PUT or DELETE, so the card
 * and its contacts change together or not at all.
 */

type Db = ReturnType<typeof getDb>;
/** A contact name from the Contacts API is at most 100 characters (`src/app/api/contacts/route.ts`). */
export const MAX_CONTACT_NAME = 100;
/** Rows per insert: 7 bound parameters each, so a chunk stays under D1's 100. */
const ROWS_PER_INSERT = 10;

/** A card's name as a contact name: not empty, not just one of its addresses (the reader's fallback for a card without a name), at most 100 characters. */
export const usableName = (fn: string, emails: string[]): string | null => {
	const name = fn.trim();
	return name && name.length <= MAX_CONTACT_NAME && !emails.includes(name.toLowerCase()) ? name : null;
};

/** `own`: the owner's own addresses (`ownAddresses`), which the card does not mirror. */
export type MirroredCard = { id: string; fn: string; emails: string[]; group: boolean; own: ReadonlySet<string> };

/**
 * Batch statements that bring the contacts of a user in line with a card: addresses no longer on it are unlinked (the
 * contact stays), every address on it is upserted as a manual contact linked to it and named after it, unless another card
 * linked it first. `blocked`, the avatar and the last-seen time are never touched. A group card mirrors nothing, and neither
 * do the owner's own addresses on a card.
 */
export function mirrorCardStatements(db: Db, userId: string, card: MirroredCard): unknown[] {
	const addresses = card.group ? [] : card.emails.filter((email) => !card.own.has(email));
	const mine = and(eq(contacts.userId, userId), eq(contacts.davCardId, card.id));
	const statements: unknown[] = [db.update(contacts).set({ davCardId: null }).where(addresses.length ? and(mine, notInArray(contacts.email, addresses)) : mine)];
	const name = usableName(card.fn, card.emails);
	for (let i = 0; i < addresses.length; i += ROWS_PER_INSERT) {
		const rows = addresses.slice(i, i + ROWS_PER_INSERT).map((email) => ({ id: getContactId(userId, email), userId, email, displayName: name, source: "manual" as const, davCardId: card.id }));
		statements.push(
			db.insert(contacts).values(rows).onConflictDoUpdate({
				target: [contacts.userId, contacts.email],
				// MySQL evaluates the assignments in the table's column order and a later one sees an earlier one's result (SQLite and
				// PostgreSQL see the old row throughout); Drizzle writes them in that column order, not in the order given here. Neither
				// expression depends on that: the name's test ("not linked, or linked to this card") is true before and after the link
				// is set to coalesce(old, new), and the link does not read the name. `values(...)` is MySQL's spelling of the new row (`excluded`).
				set: {
					displayName: sql`case when ${contacts.davCardId} is null or ${contacts.davCardId} = ${excluded(contacts.davCardId)} then coalesce(${excluded(contacts.displayName)}, ${contacts.displayName}) else ${contacts.displayName} end`,
					source: "manual",
					davCardId: sql`coalesce(${contacts.davCardId}, ${excluded(contacts.davCardId)})`,
				},
			}),
		);
	}
	return statements;
}

/** The statement for a deleted card: its contacts stay, unlinked. */
export const unlinkCardStatement = (db: Db, userId: string, cardId: string) => db.update(contacts).set({ davCardId: null }).where(and(eq(contacts.userId, userId), eq(contacts.davCardId, cardId)));

/**
 * Which of `among` are the owner's own personal addresses (every personal mailbox, its aliases and, for a mailbox on all
 * domains, its address on each). A card never makes or names a contact for one of them, and neither does seeding: the
 * account's name and its own contacts are managed in Mailflare (`syncPersonalIdentity`), DAV does not rename the account.
 * One statement settles the usual case (no address in `among` has the local part of a personal mailbox or alias); only
 * then are the full address lists read.
 */
export async function ownAddresses(env: CloudflareEnv, userId: string, among: string[]): Promise<ReadonlySet<string>> {
	const db = getDb(env);
	const rows = await db.select({ mailbox: mailboxes, alias: mailboxAliases.localPart }).from(mailboxes).leftJoin(mailboxAliases, eq(mailboxAliases.mailboxId, mailboxes.id)).where(and(eq(mailboxes.userId, userId), eq(mailboxes.type, "personal")));
	const localParts = new Set(rows.flatMap((row) => [row.mailbox.localPart, row.alias ?? ""]).map((part) => part.toLowerCase()));
	if (!among.some((address) => localParts.has(address.slice(0, address.indexOf("@")).toLowerCase()))) return new Set();
	const own = new Set<string>();
	for (const mailbox of new Map(rows.map((row) => [row.mailbox.id, row.mailbox])).values()) for (const address of await getMailboxDomainAddresses(db, mailbox)) own.add(address);
	return own;
}

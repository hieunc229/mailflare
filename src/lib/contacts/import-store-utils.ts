import { RequestBodyTooLargeError } from "@/lib/http/errors";
import { importedContactEmails, mergeContactDetails, mergeImportedContact, normalizeContactDetails, parseStoredDetails } from "./details-utils";
import { googleCsvMapper, MAX_CSV_COLUMNS, MAX_CSV_FIELD } from "./google-csv";
import type { ContactImportBody, ContactImportPlan, ExistingContact, ImportedCard } from "./import-store-types";
import { getContactId } from "./utils";
import { MAX_CARD_CHARS, parseVcard } from "./vcard";

/** Cards (or CSV rows) one request may carry. */
export const MAX_REQUEST_ITEMS = 100;
/** Contact rows one request may write: a card with several addresses writes one row per address. */
export const MAX_REQUEST_ADDRESSES = 400;
/** `contacts` has 10 columns: 8 rows are 80 bound parameters, under D1's limit of 100. */
export const CONTACTS_PER_INSERT = 8;
/** `contact_details` has 3 columns. */
export const DETAILS_PER_INSERT = 30;
/** `id IN (...)` plus the user id: 91 parameters. */
export const SELECT_CHUNK = 90;
export const STATEMENTS_PER_BATCH = 50;

export function chunk<T>(items: T[], size: number): T[][] {
	const chunks: T[][] = [];
	for (let index = 0; index < items.length; index += size) chunks.push(items.slice(index, index + size));
	return chunks;
}

const object = (value: unknown): Record<string, unknown> | null => (value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null);
const strings = (value: unknown, max: number, maxLength: number): value is string[] => Array.isArray(value) && value.length <= max && value.every((item) => typeof item === "string" && item.length <= maxLength);

/** Checks the untrusted JSON body of POST /api/import/contacts. */
export function readContactImportBody(body: unknown): { value: ContactImportBody; error?: undefined } | { error: string; value?: undefined } {
	const input = object(body);
	if (!input || typeof input.mailboxId !== "string" || !input.mailboxId || input.mailboxId.length > 200) return { error: "A mailbox is required" };
	if (input.format === "vcard") {
		const { items } = input;
		if (input.csv !== undefined || !Array.isArray(items) || items.length < 1 || items.length > MAX_REQUEST_ITEMS) return { error: `Send 1 to ${MAX_REQUEST_ITEMS} contacts per request` };
		const cards: { vcard: string; hasPhoto: boolean }[] = [];
		for (const item of items) {
			const card = object(item);
			if (!card || typeof card.vcard !== "string" || card.vcard.length > MAX_CARD_CHARS || typeof card.hasPhoto !== "boolean") return { error: "Invalid or oversized contact" };
			cards.push({ vcard: card.vcard, hasPhoto: card.hasPhoto });
		}
		return { value: { mailboxId: input.mailboxId, format: "vcard", items: cards } };
	}
	if (input.format === "google-csv") {
		const csv = object(input.csv);
		if (input.items !== undefined || !csv || !strings(csv.header, MAX_CSV_COLUMNS, MAX_CSV_FIELD)) return { error: "Invalid CSV header" };
		const { rows } = csv;
		if (!Array.isArray(rows) || rows.length < 1 || rows.length > MAX_REQUEST_ITEMS) return { error: `Send 1 to ${MAX_REQUEST_ITEMS} contacts per request` };
		if (!rows.every((row) => strings(row, MAX_CSV_COLUMNS, MAX_CSV_FIELD))) return { error: "Invalid CSV row" };
		return { value: { mailboxId: input.mailboxId, format: "google-csv", csv: { header: csv.header, rows: rows as string[][] } } };
	}
	return { error: "Unknown format" };
}

/** The cards of a validated body. Never throws: bad text becomes a card without addresses. */
export function parseContactImportCards(body: ContactImportBody): ImportedCard[] {
	if (body.format === "vcard") return (body.items ?? []).map((item) => ({ contact: parseVcard(item.vcard), hasPhoto: item.hasPhoto }));
	const map = googleCsvMapper(body.csv?.header ?? []);
	return (body.csv?.rows ?? []).map((row) => ({ contact: map(row), hasPhoto: false }));
}

type State = { email: string; exists: boolean; displayName: string | null; source: ExistingContact["source"]; avatarKey: string | null; detailsExist: boolean; touched: boolean; before: { displayName: string | null; source: ExistingContact["source"]; details: string | null }; details: string | null };

/**
 * Decides what an import writes, without touching the database. Every address on a card becomes or updates one contact.
 * An existing contact keeps a name set in the address book and takes the imported name otherwise (see
 * mergeImportedContact); blocked and remote-content settings are never part of a plan. A card's details are merged
 * into the stored ones (mergeContactDetails) and written when that changes them, so importing the same file again
 * plans nothing. A card with a single address and no other detail writes no details row and leaves an existing one
 * alone. A photo is never planned for an address in `ownAddresses` (the user's own identities).
 */
export function planContactImport(input: { userId: string; cards: ImportedCard[]; existing: Map<string, ExistingContact>; existingDetails: Map<string, string>; now: Date; ownAddresses?: ReadonlySet<string> }): ContactImportPlan {
	const plan: ContactImportPlan = { contacts: [], renames: [], detailInserts: [], detailUpdates: [], created: 0, updated: 0, unchanged: 0, noEmail: 0, photoTargets: [] };
	const states = new Map<string, State>();
	const photoTargets = new Set<string>();
	const stateOf = (email: string): State => {
		const id = getContactId(input.userId, email);
		let state = states.get(id);
		if (!state) {
			const found = input.existing.get(id);
			const stored = input.existingDetails.get(id);
			const details = stored === undefined ? null : JSON.stringify(parseStoredDetails(stored));
			state = {
				email, exists: !!found, displayName: found?.displayName ?? null, source: found?.source ?? "import", avatarKey: found?.avatarKey ?? null,
				detailsExist: stored !== undefined, touched: false, before: { displayName: found?.displayName ?? null, source: found?.source ?? "import", details }, details,
			};
			states.set(id, state);
		}
		return state;
	};
	let addresses = 0;
	for (const { contact, hasPhoto } of input.cards) {
		const emails = importedContactEmails(contact.emails);
		if (!emails.length) { plan.noEmail++; continue; }
		addresses += emails.length;
		if (addresses > MAX_REQUEST_ADDRESSES) throw new RequestBodyTooLargeError("Too many addresses in one request");
		const details = normalizeContactDetails({ ...contact.details, emails });
		const bare = emails.length <= 1 && Object.keys(details).length === 1;
		for (const email of emails) {
			const state = stateOf(email);
			const merged = mergeImportedContact(state.exists || state.touched ? { displayName: state.displayName, source: state.source } : null, contact.name);
			state.displayName = merged.displayName;
			state.source = merged.source;
			if (!bare) state.details = JSON.stringify(mergeContactDetails(state.details ? parseStoredDetails(state.details) : null, details));
			state.touched = true;
		}
		// Never the user's own profile picture: an own identity address is not a photo target.
		if (hasPhoto && !stateOf(emails[0]).avatarKey && !input.ownAddresses?.has(emails[0])) photoTargets.add(emails[0]);
	}
	for (const [id, state] of states) {
		const details = state.details !== null && state.details !== state.before.details ? { contactId: id, details: state.details, updatedAt: input.now } : null;
		if (!state.exists) {
			plan.created++;
			plan.contacts.push({ id, userId: input.userId, email: state.email, displayName: state.displayName, source: state.source });
			if (details) plan.detailInserts.push(details);
			continue;
		}
		const renamed = state.displayName !== state.before.displayName || state.source !== state.before.source;
		if (renamed) plan.renames.push({ id, displayName: state.displayName, source: state.source });
		if (details) (state.detailsExist ? plan.detailUpdates : plan.detailInserts).push(details);
		if (renamed || details) plan.updated++; else plan.unchanged++;
	}
	plan.photoTargets = [...photoTargets];
	return plan;
}

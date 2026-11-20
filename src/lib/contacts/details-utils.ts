import type { ContactNameSource } from "./types";
import type { ContactDetailsData } from "./details-types";

export const MAX_NAME = 100;
export const MAX_EMAIL = 254;
const MAX_EMAILS = 20;
const MAX_PHONES = 20;
const MAX_ADDRESSES = 10;
const MAX_TYPE = 32;
const MAX_PHONE = 64;
const MAX_ADDRESS = 500;
const MAX_ORGANIZATION = 200;
const MAX_NOTE = 4000;
const CONTROLS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
const LINE_CONTROLS = /[\u0000-\u001f\u007f]+/g;
/** A bare address: no display name, no list separators, and a dot in the domain. */
const BARE_ADDRESS = /^[^@\s<>",;]{1,64}@[^@\s<>",;]+\.[^@\s<>",;]+$/;

/** One line: controls (and so line breaks) become a space, the ends are trimmed and the length is capped. */
export function cleanLine(value: unknown, max: number): string {
	if (typeof value !== "string") return "";
	return value.slice(0, max * 2).replace(LINE_CONTROLS, " ").replace(/ {2,}/g, " ").trim().slice(0, max).trim();
}

/** Text that may span lines: controls other than tab and line breaks are removed, CRLF becomes LF. */
export function cleanText(value: unknown, max: number): string {
	if (typeof value !== "string") return "";
	return value.slice(0, max * 2).replace(/\r\n?/g, "\n").replace(CONTROLS, "").trim().slice(0, max).trim();
}

/** The valid addresses of a card as stored: lower-cased, de-duplicated, order kept, at most 20. */
export function importedContactEmails(raw: unknown[]): string[] {
	const emails: string[] = [];
	for (const value of raw) {
		if (typeof value !== "string" || value.length > MAX_EMAIL * 2) continue;
		const address = cleanLine(value, MAX_EMAIL).toLowerCase();
		if (address.length > MAX_EMAIL || !BARE_ADDRESS.test(address) || emails.includes(address)) continue;
		emails.push(address);
		if (emails.length >= MAX_EMAILS) break;
	}
	return emails;
}

/** `YYYY-MM-DD`, or `--MM-DD` without a year; undefined for anything else (including impossible dates). */
export function normalizeBirthday(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const match = /^(\d{4}|--)-?(\d{2})-?(\d{2})/.exec(value.trim().slice(0, 20));
	if (!match) return undefined;
	const month = Number(match[2]);
	const day = Number(match[3]);
	if (month < 1 || month > 12 || day < 1 || day > 31) return undefined;
	return match[1] === "--" ? `--${match[2]}-${match[3]}` : `${match[1]}-${match[2]}-${match[3]}`;
}

type Pair = Record<string, unknown>;
const isPair = (value: unknown): value is Pair => !!value && typeof value === "object" && !Array.isArray(value);

/**
 * The only way details enter or leave the table: unknown keys are dropped, text is cleaned, lengths and counts are
 * capped and empty values are removed. Applied to imported data before it is written and to stored JSON before it is
 * served.
 *
 * A future CSV export of contacts must neutralize cells that start with = + - or @ (see csvSafeCell).
 */
export function normalizeContactDetails(input: unknown): ContactDetailsData {
	const out: ContactDetailsData = {};
	if (!isPair(input)) return out;
	const emails = Array.isArray(input.emails) ? importedContactEmails(input.emails.slice(0, MAX_EMAILS * 4)) : [];
	if (emails.length) out.emails = emails;
	const seenPhones = new Set<string>();
	const phones: NonNullable<ContactDetailsData["phones"]> = [];
	for (const item of Array.isArray(input.phones) ? input.phones.slice(0, MAX_PHONES * 4) : []) {
		if (!isPair(item)) continue;
		const value = cleanLine(item.value, MAX_PHONE);
		const key = value.replace(/[\s().-]/g, "");
		if (!key || seenPhones.has(key)) continue;
		seenPhones.add(key);
		phones.push({ type: cleanLine(item.type, MAX_TYPE), value });
		if (phones.length >= MAX_PHONES) break;
	}
	if (phones.length) out.phones = phones;
	const seenAddresses = new Set<string>();
	const addresses: NonNullable<ContactDetailsData["addresses"]> = [];
	for (const item of Array.isArray(input.addresses) ? input.addresses.slice(0, MAX_ADDRESSES * 4) : []) {
		if (!isPair(item)) continue;
		const formatted = cleanLine(item.formatted, MAX_ADDRESS);
		const key = formatted.toLowerCase();
		if (!formatted || seenAddresses.has(key)) continue;
		seenAddresses.add(key);
		addresses.push({ type: cleanLine(item.type, MAX_TYPE), formatted });
		if (addresses.length >= MAX_ADDRESSES) break;
	}
	if (addresses.length) out.addresses = addresses;
	const organization = cleanLine(input.organization, MAX_ORGANIZATION);
	if (organization) out.organization = organization;
	const title = cleanLine(input.title, MAX_ORGANIZATION);
	if (title) out.title = title;
	const birthday = normalizeBirthday(input.birthday);
	if (birthday) out.birthday = birthday;
	const note = cleanText(input.note, MAX_NOTE);
	if (note) out.note = note;
	return out;
}

/** The details of one card: its addresses are kept apart, as the contact's own rows. */
export function withoutEmails(details: ContactDetailsData): Omit<ContactDetailsData, "emails"> {
	const rest = { ...details };
	delete rest.emails;
	return rest;
}

/** Stored details JSON, normalized again; unreadable JSON is "no details". */
export function parseStoredDetails(json: string | null | undefined): ContactDetailsData {
	if (!json || json.length > 64 * 1024) return {};
	try {
		return normalizeContactDetails(JSON.parse(json));
	} catch {
		return {};
	}
}

/**
 * What the import writes to an existing (or new) contact's name and source. A name you set yourself (source `manual`) is
 * kept, and a manual contact stays manual. Any other name is replaced by the imported one and the contact becomes
 * `import`, so a later import may update that name again but never one you edited (editing makes it `manual`); an
 * `outbound` contact keeps that source (the name rules still apply) so an import never downgrades it. Without an
 * imported name the name stays, but an inbound contact on an imported card still becomes `import`.
 * `import` is treated like `manual` everywhere a contact counts as known or its name is shown (spam score, agent send
 * review, display name). `blocked` and `remoteContentAllowed` are never part of this decision.
 */
export function mergeImportedContact(existing: ContactNameSource | null, importedName: string | null): { displayName: string | null; source: ContactNameSource["source"] } {
	const name = cleanLine(importedName, MAX_NAME) || null;
	if (existing?.source === "manual") return { displayName: existing.displayName?.trim() ? existing.displayName : name ?? existing.displayName, source: "manual" };
	const source = existing?.source === "outbound" ? "outbound" : "import";
	return { displayName: name ?? existing?.displayName ?? null, source };
}

/**
 * The stored details with one more card's details folded in, for a re-import: addresses, phones and postal addresses
 * are united (same normalized value counts once, the stored label wins); organization, title, birthday and note come
 * from the card when it has them and stay as stored when it lacks them.
 */
export function mergeContactDetails(existing: ContactDetailsData | null, incoming: ContactDetailsData): ContactDetailsData {
	return normalizeContactDetails({
		emails: [...(existing?.emails ?? []), ...(incoming.emails ?? [])],
		phones: [...(existing?.phones ?? []), ...(incoming.phones ?? [])],
		addresses: [...(existing?.addresses ?? []), ...(incoming.addresses ?? [])],
		organization: incoming.organization ?? existing?.organization,
		title: incoming.title ?? existing?.title,
		birthday: incoming.birthday ?? existing?.birthday,
		note: incoming.note ?? existing?.note,
	});
}

/** A stored birthday for display in `locale`: "May 1, 1980", or "May 1" when the year is unknown. */
export function formatBirthday(value: string, locale: string): string {
	const match = /^(?:(\d{4})-|--)(\d{2})-(\d{2})$/.exec(value);
	if (!match) return value;
	const date = new Date(0);
	date.setUTCFullYear(match[1] ? Number(match[1]) : 2000, Number(match[2]) - 1, Number(match[3]));
	try {
		return new Intl.DateTimeFormat(locale, { timeZone: "UTC", month: "long", day: "numeric", ...(match[1] ? { year: "numeric" } : {}) }).format(date);
	} catch {
		return value;
	}
}

/** A CSV cell that spreadsheet software will not run as a formula: a leading = + - or @ gets a quote in front. */
export function csvSafeCell(value: string): string {
	return /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
}

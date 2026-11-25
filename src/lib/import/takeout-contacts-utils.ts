import { importedContactEmails } from "../contacts/details-utils";
import { decodeContactsCsv, googleCsvMapper, isGoogleContactsHeader, MAX_CSV_ROWS, parseCsv } from "../contacts/google-csv";
import { decodeContactPhoto, MAX_VCARDS, parseVcard, splitVcards } from "../contacts/vcard";
import type { ContactPhoto } from "../contacts/vcard-types";
import { parseRetryAfter, sleepFor } from "./takeout-calendar-utils";
import type { TranslationKey } from "../i18n/types";
import type { ContactPhotoUpload, ContactPost, ContactRunNotice, ContactPostResult, ContactRunOptions, ContactRunSettings, ContactRunSummary } from "./takeout-contacts-types";

export { parseRetryAfter };

const BATCH_ITEMS = 100;
const BATCH_CHARS = 256 * 1024;
const MAX_ERRORS = 5;
const MAX_NAMES = 5;
/** The server refuses bodies over 1 MiB; stay 16 KiB under it. */
const BODY_BYTES = 1024 * 1024 - 16 * 1024;
const RATE_LIMIT_TRIES = 5;
const RATE_LIMIT_BACKOFF_MS = 2000;
const encoder = new TextEncoder();
const bodyBytes = (body: unknown) => encoder.encode(JSON.stringify(body)).length;

type Item = {
	size: number;
	/** The first valid address, where a photo goes. */
	primary: string;
	photo: ContactPhoto | null;
	send: { vcard: string; hasPhoto: boolean } | string[];
};

type Prepared = {
	format: "vcard" | "google-csv";
	header: string[];
	/** Contacts with a valid address: the only ones sent. */
	items: Item[];
	summary: ContactRunSummary;
};

const emptySummary = (): ContactRunSummary => ({ cards: 0, withEmail: 0, noEmail: 0, noEmailNames: [], created: 0, updated: 0, unchanged: 0, failed: 0, errors: [], photosUploaded: 0, photosFailed: 0, aborted: false, rateLimited: false });

/** The file is not something this import reads. `key` is the catalog key of the message to show. */
export class ContactsFileError extends Error {
	constructor(readonly key: TranslationKey, message: string) {
		super(message);
	}
}

const sameNotice = (a: ContactRunNotice, b: ContactRunNotice) => (typeof a === "string" || typeof b === "string" ? a === b : a.key === b.key && JSON.stringify(a.params) === JSON.stringify(b.params));

function addError(summary: ContactRunSummary, notice: ContactRunNotice) {
	if (summary.errors.length < MAX_ERRORS && !summary.errors.some((known) => sameNotice(known, notice))) summary.errors.push(notice);
}

/** Batches of at most 100 contacts and 256 KiB; a larger contact travels alone. */
export function makeContactBatches<T extends { size: number }>(items: T[]): T[][] {
	const batches: T[][] = [];
	let current: T[] = [];
	let chars = 0;
	for (const item of items) {
		if (current.length && (current.length >= BATCH_ITEMS || chars + item.size > BATCH_CHARS)) {
			batches.push(current);
			current = [];
			chars = 0;
		}
		current.push(item);
		chars += item.size;
	}
	if (current.length) batches.push(current);
	return batches;
}

/**
 * Reads a contacts file in the browser: vCard cards (photos set aside) or the rows of a Google CSV. Contacts without
 * a valid address are counted here and never sent. Throws for a CSV that is not a Google contacts export.
 */
function prepare(bytes: Uint8Array, kind: "vcard" | "csv"): Prepared {
	const summary = emptySummary();
	const items: Item[] = [];
	const skip = (name: string | null) => {
		summary.noEmail++;
		if (name && summary.noEmailNames.length < MAX_NAMES) summary.noEmailNames.push(name);
	};
	if (kind === "vcard") {
		const split = splitVcards(bytes);
		summary.cards = split.cards.length + split.tooLarge;
		if (split.tooLarge) { summary.failed += split.tooLarge; addError(summary, { key: "importPage.takeoutDataContactsTooLarge", params: { count: split.tooLarge } }); }
		if (split.truncated) addError(summary, { key: "importPage.takeoutDataContactsCapped", params: { count: MAX_VCARDS } });
		for (const card of split.cards) {
			const contact = parseVcard(card.text);
			const [primary] = importedContactEmails(contact.emails);
			if (!primary) { skip(contact.name); continue; }
			items.push({ size: card.text.length, primary, photo: card.photo, send: { vcard: card.text, hasPhoto: card.photo?.kind === "inline" } });
		}
		summary.withEmail = items.length;
		return { format: "vcard", header: [], items, summary };
	}
	const { rows, truncated } = parseCsv(decodeContactsCsv(bytes));
	const header = rows[0] ?? [];
	if (!isGoogleContactsHeader(header)) throw new ContactsFileError("importPage.takeoutDataContactsNotGoogleCsv", "This is not a Google contacts CSV file");
	if (truncated) addError(summary, { key: "importPage.takeoutDataContactsCapped", params: { count: MAX_CSV_ROWS - 1 } });
	const map = googleCsvMapper(header);
	summary.cards = rows.length - 1;
	for (const row of rows.slice(1)) {
		const contact = map(row);
		const [primary] = importedContactEmails(contact.emails);
		if (!primary) { skip(contact.name); continue; }
		items.push({ size: row.reduce((sum, cell) => sum + cell.length + 1, 0), primary, photo: null, send: row });
	}
	summary.withEmail = items.length;
	return { format: "google-csv", header, items, summary };
}

/**
 * Sends the contacts of one file to POST /api/import/contacts in bounded batches. A body is kept under the server's
 * 1 MiB by its encoded length: a batch over it is halved, and a single contact still over it is counted as too large.
 * A batch the server cannot take (413, 5xx, network error) is halved and retried down to single contacts; one that still
 * fails is counted. A 429 waits (Retry-After, else 2, 4, 8 s) and retries the same batch, and after RATE_LIMIT_TRIES
 * stops with `rateLimited` set. Other errors (signed out, mailbox not found, migrations pending) stop the import with the
 * server's message. After each batch, photos are uploaded for the addresses the server names (contacts that have no
 * picture yet). Safe to run again: the server changes nothing that is already there.
 */
export async function importContactsBytes(bytes: Uint8Array, kind: "vcard" | "csv", settings: ContactRunSettings, run: ContactRunOptions & { post: ContactPost; uploadPhoto: ContactPhotoUpload }): Promise<ContactRunSummary> {
	const { format, header, items, summary } = prepare(bytes, kind);
	let done = 0;
	const bodyFor = (batch: Item[]) => format === "vcard"
		? { mailboxId: settings.mailboxId, format, items: batch.map((item) => item.send) }
		: { mailboxId: settings.mailboxId, format, csv: { header, rows: batch.map((item) => item.send) } };
	const progress = (count: number) => { done += count; run.onProgress?.(done, items.length); };

	async function uploadPhotos(batch: Item[], targets: unknown) {
		if (!settings.photos || !Array.isArray(targets)) return;
		const byAddress = new Map(batch.filter((item) => item.photo?.kind === "inline").map((item) => [item.primary, item.photo]));
		for (const address of targets) {
			if (run.signal?.aborted) return;
			const photo = typeof address === "string" ? byAddress.get(address) : undefined;
			if (!photo) continue;
			const decoded = decodeContactPhoto(photo);
			if (!decoded) { summary.photosFailed++; addError(summary, { key: "importPage.takeoutDataPhotoUnsupported" }); continue; }
			try {
				await run.uploadPhoto(address as string, new File([decoded.bytes as BlobPart], "photo", { type: decoded.mime }));
				summary.photosUploaded++;
			} catch (error) {
				summary.photosFailed++;
				addError(summary, error instanceof Error ? error.message : String(error));
			}
		}
	}

	async function halve(batch: Item[]): Promise<void> {
		const middle = Math.ceil(batch.length / 2);
		await send(batch.slice(0, middle));
		await send(batch.slice(middle));
	}

	async function send(batch: Item[]): Promise<void> {
		if (run.signal?.aborted) { summary.aborted = true; return; }
		if (summary.rateLimited) return;
		const body = bodyFor(batch);
		if (bodyBytes(body) > BODY_BYTES) {
			if (batch.length > 1) return halve(batch);
			summary.failed++;
			addError(summary, { key: "importPage.takeoutDataContactTooBig" });
			progress(1);
			return;
		}
		let result: ContactPostResult;
		for (let attempt = 1; ; attempt++) {
			try {
				result = await run.post(body, run.signal);
			} catch (error) {
				if (run.signal?.aborted) { summary.aborted = true; return; }
				result = { status: 0, data: { error: error instanceof Error ? error.message : String(error) } };
			}
			if (result.status !== 429) break;
			if (attempt >= RATE_LIMIT_TRIES) { summary.rateLimited = true; return; }
			await (run.sleep ?? sleepFor)(result.retryAfterMs ?? RATE_LIMIT_BACKOFF_MS * 2 ** (attempt - 1), run.signal);
			if (run.signal?.aborted) { summary.aborted = true; return; }
		}
		const { status, data } = result;
		if (status === 200) {
			summary.created += data.created ?? 0;
			summary.updated += data.updated ?? 0;
			summary.unchanged += data.unchanged ?? 0;
			summary.noEmail += data.noEmail ?? 0;
			progress(batch.length);
			await uploadPhotos(batch, data.photoTargets);
			return;
		}
		if (status !== 0 && status !== 413 && status < 500) throw new Error(data.error ?? `HTTP ${status}`);
		if (batch.length > 1) return halve(batch);
		summary.failed++;
		addError(summary, data.error ?? `HTTP ${status}`);
		progress(1);
	}

	for (const batch of makeContactBatches(items)) {
		if (run.signal?.aborted) { summary.aborted = true; break; }
		await send(batch);
		if (summary.aborted || summary.rateLimited) break;
	}
	return summary;
}

/** Counts what an import would do, in the browser with the same parsers the server uses; posts nothing. */
export async function previewContactsBytes(bytes: Uint8Array, kind: "vcard" | "csv", run: Pick<ContactRunOptions, "signal" | "onProgress">): Promise<ContactRunSummary> {
	const { summary } = prepare(bytes, kind);
	run.onProgress?.(summary.cards, summary.cards);
	return summary;
}

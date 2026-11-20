import { decodeContactsCsv, isGoogleContactsHeader, parseCsv } from "../contacts/google-csv";
import type { ContactSource, TakeoutScan, TakeoutSource } from "./takeout-data-types";
import type { ZipEntry } from "./zip-types";
import { listZipEntries, openZipEntry, readStreamChunks, readZipEntryBytes } from "./zip-utils";

/** Text sources (.ics, .vcf, .csv) are read whole, so each is capped. */
export const MAX_TEXT_SOURCE_BYTES = 64 * 1024 * 1024;
/** Enough for the longest Google contacts header. */
const HEADER_PEEK_BYTES = 64 * 1024;

const basename = (name: string) => name.split(/[\\/]/).pop() ?? name;
const stem = (name: string) => name.replace(/\.[^.]*$/, "");

/** The first bytes of a file or zip entry; a deflated entry is cut off after them instead of being inflated. */
async function peek(file: File, entry: ZipEntry | null): Promise<Uint8Array> {
	if (!entry) return new Uint8Array(await file.slice(0, HEADER_PEEK_BYTES).arrayBuffer());
	const parts: Uint8Array[] = [];
	let total = 0;
	for await (const chunk of readStreamChunks(await openZipEntry(file, entry))) {
		parts.push(chunk);
		total += chunk.length;
		if (total >= HEADER_PEEK_BYTES) break;
	}
	const bytes = new Uint8Array(Math.min(total, HEADER_PEEK_BYTES));
	let offset = 0;
	for (const part of parts) {
		const take = part.subarray(0, bytes.length - offset);
		bytes.set(take, offset);
		offset += take.length;
	}
	return bytes;
}

/** Whether a .csv is a Google contacts export: its first row has a name column and an e-mail value column. */
async function isGoogleContactsCsv(file: File, entry: ZipEntry | null): Promise<boolean> {
	try {
		return isGoogleContactsHeader(parseCsv(decodeContactsCsv(await peek(file, entry)), { maxRows: 1 }).rows[0] ?? []);
	} catch {
		return false;
	}
}

/**
 * Finds what the picked files hold: calendars (.ics) and contacts (.vcf, and .csv with a Google contacts header), as
 * plain files or entries of Takeout zips. Entries are classified by extension, not folder name, because Takeout folder
 * names are localized. Only the zip directories (and the first bytes of each CSV) are read here. Entry names are labels
 * only; they never become paths.
 */
export async function scanTakeoutData(files: File[]): Promise<TakeoutScan> {
	const scan: TakeoutScan = { calendars: [], contacts: [], tooLarge: [], ignored: [], unreadable: [] };
	let count = 0;
	const add = (target: TakeoutSource[], extra: object, file: File, entry: ZipEntry | null, name: string, size: number) => {
		if (size > MAX_TEXT_SOURCE_BYTES) scan.tooLarge.push(name);
		else target.push({ id: `${count++}:${file.name}:${entry?.name ?? ""}`, label: stem(name), size, file, entry, ...extra });
	};
	const classify = async (file: File, entry: ZipEntry | null, name: string, size: number): Promise<boolean> => {
		if (/\.ics$/i.test(name)) add(scan.calendars, {}, file, entry, name, size);
		else if (/\.vcf$/i.test(name)) add(scan.contacts, { kind: "vcard" } satisfies Pick<ContactSource, "kind">, file, entry, name, size);
		else if (/\.csv$/i.test(name) && await isGoogleContactsCsv(file, entry)) add(scan.contacts, { kind: "csv" } satisfies Pick<ContactSource, "kind">, file, entry, name, size);
		else return false;
		return true;
	};
	for (const file of files) {
		if (/\.zip$/i.test(file.name)) {
			let entries;
			try { entries = await listZipEntries(file); } catch { scan.unreadable.push(file.name); continue; }
			for (const entry of entries) {
				const name = basename(entry.name);
				if (entry.name.endsWith("/") || name.startsWith(".") || entry.isSymlink || entry.encrypted || /^__MACOSX\//.test(entry.name)) continue;
				await classify(file, entry, name, entry.size);
			}
		} else if (!(await classify(file, null, file.name, file.size))) scan.ignored.push(file.name);
	}
	return scan;
}

export async function readTakeoutSource(source: TakeoutSource): Promise<Uint8Array> {
	if (source.entry) return readZipEntryBytes(source.file, source.entry, MAX_TEXT_SOURCE_BYTES);
	if (source.size > MAX_TEXT_SOURCE_BYTES) throw new Error(`${source.label} is too large`);
	return new Uint8Array(await source.file.arrayBuffer());
}

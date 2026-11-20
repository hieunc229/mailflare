import { decodeContactsCsv, isGoogleContactsHeader, parseCsv } from "../contacts/google-csv";
import { takeoutDrivePath } from "../drive/import-utils";
import type { ContactSource, DriveRoot, TakeoutScan, TakeoutSource } from "./takeout-data-types";
import type { ZipEntry } from "./zip-types";
import { listZipEntries, openZipEntry, readStreamChunks, readZipEntryBytes } from "./zip-utils";

/** Text sources (.ics, .vcf, .csv) are read whole, so each is capped. */
export const MAX_TEXT_SOURCE_BYTES = 64 * 1024 * 1024;
/** Files (and, separately, empty folders) one scan collects for Drive from each product folder; the zip reader already stops at 500,000 entries. */
export const MAX_DRIVE_FILES = 200_000;
const MAX_REJECTED_SHOWN = 20;
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

/** The product folder of a Takeout entry: `Takeout/<product>` or, in a re-zipped export, the first folder. Null for a top-level file. */
function driveRootOf(entryName: string): string[] | null {
	const parts = entryName.split(/[\\/]/).filter((part) => part !== "" && part !== ".");
	if (parts[0] === "Takeout") return parts.length >= 3 || (parts.length === 2 && entryName.endsWith("/")) ? parts.slice(0, 2) : null;
	return parts.length >= 2 || (parts.length === 1 && entryName.endsWith("/")) ? parts.slice(0, 1) : null;
}

const JUNK_NAME = /^(\.DS_Store|Thumbs\.db|desktop\.ini|\._.*)$/i;

/**
 * Finds what the picked files hold: calendars (.ics) and contacts (.vcf, and .csv with a Google contacts header), as
 * plain files or entries of Takeout zips, and the files of the Drive folder (and of other product folders, for the
 * user to choose from). Entries are classified by extension, not folder name, because Takeout folder names are
 * localized; the exception is a folder called `Drive`, whose .ics, .vcf and .csv files are the user's own Drive files
 * and never calendars or contacts. Only the zip directories (and the first bytes of each CSV) are read here. Entry
 * names are labels and Drive item names only; they never become paths.
 */
export async function scanTakeoutData(files: File[], options: { maxDriveFiles?: number } = {}): Promise<TakeoutScan> {
	const maxDriveFiles = options.maxDriveFiles ?? MAX_DRIVE_FILES;
	const scan: TakeoutScan = { calendars: [], contacts: [], tooLarge: [], ignored: [], unreadable: [], drive: { roots: [], files: [], dirs: [], skipped: { symlinks: 0, encrypted: 0 }, rejected: [], rejectedCount: 0 } };
	const roots = new Map<string, DriveRoot>();
	const dirCounts = new Map<string, number>();
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
	const addDrive = (file: File, entry: ZipEntry, prefix: string[]) => {
		const key = prefix.join("/");
		const path = takeoutDrivePath(entry.name, prefix);
		if ("error" in path) {
			scan.drive.rejectedCount += 1;
			// A hostile zip could hold hundreds of thousands of bad names; only the first few are kept to show.
			if (scan.drive.rejected.length < MAX_REJECTED_SHOWN) scan.drive.rejected.push({ name: entry.name, reason: path.error });
			return;
		}
		if (path.directory) {
			if (path.segments.length > 0 && (dirCounts.get(key) ?? 0) < maxDriveFiles) {
				dirCounts.set(key, (dirCounts.get(key) ?? 0) + 1);
				scan.drive.dirs.push({ rootKey: key, segments: path.segments });
			}
			return;
		}
		if (path.segments.length === 0) return;
		const root = roots.get(key) ?? { key, prefix, label: prefix.at(-1)!, files: 0, bytes: 0, tooMany: false };
		roots.set(key, root);
		if (root.files >= maxDriveFiles) { root.tooMany = true; return; }
		scan.drive.files.push({ rootKey: key, segments: path.segments, name: path.segments.at(-1)!, size: entry.size, crc32: entry.crc32, file, entry });
		root.files += 1;
		root.bytes += entry.size;
	};
	for (const file of files) {
		if (/\.zip$/i.test(file.name)) {
			let entries;
			try { entries = await listZipEntries(file); } catch { scan.unreadable.push(file.name); continue; }
			for (const entry of entries) {
				const name = basename(entry.name);
				if (/^__MACOSX\//.test(entry.name) || JUNK_NAME.test(name)) continue;
				const prefix = driveRootOf(entry.name);
				const inDrive = prefix?.at(-1)?.toLowerCase() === "drive";
				if (entry.name.endsWith("/")) {
					if (prefix && inDrive) addDrive(file, entry, prefix);
					continue;
				}
				// Symlinks and encrypted entries never carry usable data; those in Drive are counted for the report.
				if (entry.isSymlink || entry.encrypted) {
					if (inDrive) scan.drive.skipped[entry.isSymlink ? "symlinks" : "encrypted"] += 1;
					continue;
				}
				if (prefix && inDrive) { addDrive(file, entry, prefix); continue; }
				if (name.startsWith(".") || await classify(file, entry, name, entry.size)) continue;
				// Mail and JSON sidecars are not Drive files.
				if (prefix && !/\.(json|mbox)$/i.test(name)) addDrive(file, entry, prefix);
			}
		} else if (!(await classify(file, null, file.name, file.size))) scan.ignored.push(file.name);
	}
	scan.drive.roots = [...roots.values()];
	return scan;
}

export async function readTakeoutSource(source: TakeoutSource): Promise<Uint8Array> {
	if (source.entry) return readZipEntryBytes(source.file, source.entry, MAX_TEXT_SOURCE_BYTES);
	if (source.size > MAX_TEXT_SOURCE_BYTES) throw new Error(`${source.label} is too large`);
	return new Uint8Array(await source.file.arrayBuffer());
}

import type { CalendarSource, TakeoutCalendarScan } from "./takeout-data-types";
import { listZipEntries, readZipEntryBytes } from "./zip-utils";

/** Text sources (.ics) are read whole, so each is capped. */
export const MAX_TEXT_SOURCE_BYTES = 64 * 1024 * 1024;

const basename = (name: string) => name.split(/[\\/]/).pop() ?? name;

/**
 * Finds the calendars in the picked files: .ics files, or .ics entries in Takeout zips. Entries are classified by
 * extension, not folder name, because Takeout folder names are localized. Only the zip directories are read here.
 * Entry names are labels only; they never become paths.
 */
export async function scanTakeoutCalendars(files: File[]): Promise<TakeoutCalendarScan> {
	const scan: TakeoutCalendarScan = { calendars: [], tooLarge: [], ignored: [], unreadable: [] };
	const add = (file: File, entry: CalendarSource["entry"], name: string, size: number) => {
		const label = name.replace(/\.ics$/i, "");
		if (size > MAX_TEXT_SOURCE_BYTES) scan.tooLarge.push(name);
		else scan.calendars.push({ id: `${scan.calendars.length}:${file.name}:${entry?.name ?? ""}`, label, size, file, entry });
	};
	for (const file of files) {
		if (/\.ics$/i.test(file.name)) add(file, null, file.name, file.size);
		else if (/\.zip$/i.test(file.name)) {
			let entries;
			try { entries = await listZipEntries(file); } catch { scan.unreadable.push(file.name); continue; }
			for (const entry of entries) {
				const name = basename(entry.name);
				if (!/\.ics$/i.test(name) || entry.name.endsWith("/") || name.startsWith(".") || entry.isSymlink || entry.encrypted || /^__MACOSX\//.test(entry.name)) continue;
				add(file, entry, name, entry.size);
			}
		} else scan.ignored.push(file.name);
	}
	return scan;
}

export async function readCalendarSource(source: CalendarSource): Promise<Uint8Array> {
	if (source.entry) return readZipEntryBytes(source.file, source.entry, MAX_TEXT_SOURCE_BYTES);
	if (source.size > MAX_TEXT_SOURCE_BYTES) throw new Error(`${source.label} is too large`);
	return new Uint8Array(await source.file.arrayBuffer());
}

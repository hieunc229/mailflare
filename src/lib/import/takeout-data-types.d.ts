import type { ZipEntry } from "./zip-types";

/** One file of a Takeout export that holds importable data: a calendar (.ics) or a contacts file (.vcf, or a Google CSV). */
export type TakeoutSource = {
	/** Unique within one scan. */
	id: string;
	/** The file stem; for a primary calendar that is the Google address. */
	label: string;
	size: number;
	file: File;
	/** The entry inside a zip, or null for a plain file. */
	entry: ZipEntry | null;
};

export type CalendarSource = TakeoutSource;

export type ContactSource = TakeoutSource & { kind: "vcard" | "csv" };

export type TakeoutScan = {
	calendars: CalendarSource[];
	contacts: ContactSource[];
	/** Names of files over the size cap. */
	tooLarge: string[];
	/** Picked files this importer does not read. */
	ignored: string[];
	/** Zips that could not be opened. */
	unreadable: string[];
};

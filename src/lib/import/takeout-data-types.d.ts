import type { ZipEntry } from "./zip-types";

export type CalendarSource = {
	/** Unique within one scan. */
	id: string;
	/** The file stem; for a primary calendar that is the Google address. */
	label: string;
	size: number;
	file: File;
	/** The entry inside a zip, or null for a plain .ics file. */
	entry: ZipEntry | null;
};

export type TakeoutCalendarScan = {
	calendars: CalendarSource[];
	/** Names of calendars over the size cap. */
	tooLarge: string[];
	/** Picked files this importer does not read. */
	ignored: string[];
	/** Zips that could not be opened. */
	unreadable: string[];
};

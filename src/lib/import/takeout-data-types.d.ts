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

/** A product folder of a Takeout export that holds files that could go to Drive (normally `Takeout/Drive`). */
export type DriveRoot = {
	/** The folder's path in the zip, joined with "/". */
	key: string;
	/** The same, as segments. */
	prefix: string[];
	/** The last segment, shown to the user. */
	label: string;
	files: number;
	bytes: number;
	/** More files than one import takes: the rest of this folder was not collected. */
	tooMany: boolean;
};

/** One file to import into Drive, read from a zip entry. */
export type DriveFile = {
	rootKey: string;
	/** Folders and then the file name, relative to the root: already normalized Drive names. */
	segments: string[];
	name: string;
	size: number;
	crc32: number;
	file: File;
	entry: ZipEntry;
};

export type DriveScan = {
	roots: DriveRoot[];
	files: DriveFile[];
	/** Empty directories, so they are created too. */
	dirs: { rootKey: string; segments: string[] }[];
	skipped: { symlinks: number; encrypted: number };
	/** Entries whose names could not be used (traversal, control characters, too long...), with the reason. */
	rejected: { name: string; reason: string }[];
	/** How many entries were rejected; `rejected` keeps only the first few. */
	rejectedCount: number;
};

export type TakeoutScan = {
	drive: DriveScan;
	calendars: CalendarSource[];
	contacts: ContactSource[];
	/** Names of files over the size cap. */
	tooLarge: string[];
	/** Picked files this importer does not read. */
	ignored: string[];
	/** Zips that could not be opened. */
	unreadable: string[];
};

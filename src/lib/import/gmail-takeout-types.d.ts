export type TakeoutSection = "inbox" | "sent" | "drafts" | "spam" | "trash" | "archived";

export type TakeoutDestination = { type: "system"; section: TakeoutSection } | { type: "folder"; name: string };

export interface TakeoutPlacement {
	destination: TakeoutDestination;
	read: boolean;
	starred: boolean;
}

export interface TakeoutLabelOptions {
	/** Turn custom labels into folders. Defaults to true. */
	folders?: boolean;
	/** Labels to ignore; an entry ending in "/" also ignores every label below it. */
	ignore?: string[];
}

export interface TakeoutBatchMessage {
	filename: string;
	raw: Uint8Array;
	read: boolean;
	starred: boolean;
}

export interface TakeoutUploadResponse {
	status: number;
	data: { imported?: number; skipped?: number; errors?: string[]; error?: unknown };
}

export interface TakeoutImportSummary {
	/** Messages read from the file so far. */
	read: number;
	imported: number;
	skipped: number;
	failed: number;
	/** The first error messages; `failed` has the full count. */
	errors: string[];
	tooLarge: number;
	ignored: number;
	/** Every message up to this position is finished, so a new run can start after it. */
	committed: number;
	/** Message counts per destination key (`system:inbox`, `folder:Name`). */
	destinations: Record<string, number>;
	aborted: boolean;
}

export interface TakeoutImportOptions {
	labels?: TakeoutLabelOptions;
	skipSpam?: boolean;
	skipTrash?: boolean;
	/** Skip the first n messages, e.g. the `committed` count of an interrupted run. */
	startAt?: number;
	/** Only count where messages would go. */
	dryRun?: boolean;
	signal?: AbortSignal;
	/** Sends one batch to /api/import/messages; `destination` is `system:<section>` or `folder:<id>`. */
	upload?: (destination: string, messages: TakeoutBatchMessage[], signal?: AbortSignal) => Promise<TakeoutUploadResponse>;
	/** Returns the id of the folder with this name, creating it when missing. */
	resolveFolder?: (name: string) => Promise<string>;
	onProgress?: (summary: TakeoutImportSummary) => void;
	wait?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

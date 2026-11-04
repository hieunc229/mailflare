export type ImportJobKind = "file" | "imap";

export type ImportJobStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

/** What the browser sees; timestamps are ISO strings. */
export type ImportJobSummary = {
	id: string;
	mailboxId: string;
	kind: ImportJobKind;
	label: string;
	status: ImportJobStatus;
	/** Messages known so far; an IMAP job learns each folder's size as it reaches it. */
	total: number;
	processed: number;
	imported: number;
	skipped: number;
	/** The first few per-message errors. */
	errors: string[];
	errorCount: number;
	error: string | null;
	/** The IMAP folder being read right now. */
	currentSource: string | null;
	createdAt: string;
	startedAt: string | null;
	finishedAt: string | null;
};

export type FileImportSpec = {
	destination: string;
	/** Staged batch objects, see staging.ts. */
	batches: number;
};

export type FileImportCursor = { batch: number };

export type ImapImportSource = { folder: string; destination: string };

/** The IMAP password is deliberately not part of the spec: it only travels in queue messages. */
export type ImapImportSpec = {
	host: string;
	port: number;
	secure: boolean;
	username: string;
	limit: number;
	importAll: boolean;
	sources: ImapImportSource[];
};

export type ImapImportCursor = {
	source: number;
	/** Newest messages of the current source already handled. */
	done: number;
	/** Whether the current source's size was added to the job total. */
	counted: boolean;
	/** Chunk size after earlier failures; absent means the default. */
	size?: number;
	/** Consecutive failed chunks. */
	failures?: number;
};

export type ImportJobMessage = {
	kind: "import.run";
	jobId: string;
	imapPassword?: string;
	/** Delivery count from the queue; set by the consumer, never stored. */
	attempt?: number;
};

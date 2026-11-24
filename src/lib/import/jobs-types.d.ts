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
	/** How an IMAP job signs in. File jobs leave this empty. */
	auth: "password" | "xoauth2" | null;
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

/** The IMAP password and the Outlook refresh token are deliberately not part of the spec: they only travel in queue messages. */
export type ImapImportSpec = {
	host: string;
	port: number;
	secure: boolean;
	username: string;
	limit: number;
	importAll: boolean;
	sources: ImapImportSource[];
	/** Absent on jobs created before Outlook OAuth; those sign in with a password. */
	auth?: "password" | "xoauth2";
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
	/** Outlook OAuth. The refresh token is rotated in place when Microsoft issues a new one. */
	outlookRefreshToken?: string;
	outlookClientId?: string;
	outlookClientSecret?: string;
	outlookTenant?: string;
	/** Delivery count from the queue; set by the consumer, never stored. */
	attempt?: number;
};

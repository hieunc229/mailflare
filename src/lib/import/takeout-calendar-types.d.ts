import type { CalendarImportSummary } from "../calendar/import-store-types";

export type CalendarRunSettings = {
	name: string;
	color: string;
	googleAddress: string;
	reminders: boolean;
	skipDeclined: boolean;
};

export type CalendarRunSummary = {
	/** Events in the file (masters and changed occurrences). */
	events: number;
	/** Recurring series, including those that become a single event. */
	series: number;
	imported: number;
	/** Already on the calendar, cancelled or declined. */
	skipped: number;
	simplified: number;
	guessedZone: number;
	failed: number;
	/** The first few reasons events were not imported. */
	errors: string[];
	aborted: boolean;
	/** The server kept answering 429: the rest of the file was not sent. */
	rateLimited: boolean;
};

export type CalendarPostResult = {
	status: number;
	/** From a 429's Retry-After header, in milliseconds. */
	retryAfterMs?: number;
	data: Partial<CalendarImportSummary> & { error?: string };
};

export type CalendarPost = (body: unknown, signal?: AbortSignal) => Promise<CalendarPostResult>;

export type CalendarRunOptions = {
	signal?: AbortSignal;
	/** Groups done and total. */
	onProgress?: (done: number, total: number) => void;
	/** Waits before a retry; stops early when the signal aborts. Tests pass a fake. */
	sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
};

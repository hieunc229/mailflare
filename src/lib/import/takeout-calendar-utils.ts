import { MAX_IMPORT_EVENTS, parseIcsEventGroup, splitIcsEvents } from "../calendar/ics-import";
import type { CalendarPost, CalendarRunOptions, CalendarRunSettings, CalendarRunSummary } from "./takeout-calendar-types";

const BATCH_GROUPS = 50;
const BATCH_CHARS = 256 * 1024;
const BATCH_EVENTS = 500;
const MAX_ERRORS = 5;
/** The server refuses bodies over 1 MiB; stay 16 KiB under it. */
const BODY_BYTES = 1024 * 1024 - 16 * 1024;
const RATE_LIMIT_TRIES = 5;
const RATE_LIMIT_BACKOFF_MS = 2000;
const encoder = new TextEncoder();
const bodyBytes = (body: unknown) => encoder.encode(JSON.stringify(body)).length;
export const sleepFor = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve) => {
	if (signal?.aborted) return resolve();
	const done = () => { clearTimeout(timer); signal?.removeEventListener("abort", done); resolve(); };
	const timer = setTimeout(done, ms);
	signal?.addEventListener("abort", done);
});
/** BEGIN:VEVENT only counts at the start of a line (a description may quote it), in any case. */
const countEvents = (group: string) => (group.match(/^BEGIN:VEVENT/gim) ?? []).length;

/** A Retry-After header (seconds or an HTTP date) as milliseconds, kept between 1 and 60 seconds; undefined when absent or unreadable. */
export function parseRetryAfter(value: string | null, now = Date.now()): number | undefined {
	const text = value?.trim();
	if (!text) return undefined;
	const ms = /^\d{1,9}$/.test(text) ? Number(text) * 1000 : Date.parse(text) - now;
	return Number.isFinite(ms) ? Math.min(60_000, Math.max(1000, ms)) : undefined;
}

/** Batches of UID groups for one request each: at most 50 groups, 256 KiB and 500 events; a larger group travels alone. */
export function makeBatches(groups: string[]): string[][] {
	const batches: string[][] = [];
	let current: string[] = [];
	let chars = 0;
	let events = 0;
	for (const group of groups) {
		const groupEvents = countEvents(group);
		if (current.length && (current.length >= BATCH_GROUPS || chars + group.length > BATCH_CHARS || events + groupEvents > BATCH_EVENTS)) {
			batches.push(current);
			current = [];
			chars = 0;
			events = 0;
		}
		current.push(group);
		chars += group.length;
		events += groupEvents;
	}
	if (current.length) batches.push(current);
	return batches;
}

const emptySummary = (): CalendarRunSummary => ({ events: 0, series: 0, imported: 0, skipped: 0, simplified: 0, guessedZone: 0, failed: 0, errors: [], aborted: false, rateLimited: false });

function addError(summary: CalendarRunSummary, message: string) {
	if (summary.errors.length < MAX_ERRORS) summary.errors.push(message);
}

/** Records what splitting dropped: events without a UID, UIDs too large and files over the event cap. */
function addSplitLosses(summary: CalendarRunSummary, split: ReturnType<typeof splitIcsEvents>) {
	if (split.noUid) { summary.failed += split.noUid; addError(summary, `${split.noUid} events without a UID were skipped`); }
	if (split.tooBig) { summary.failed += split.tooBig; addError(summary, `${split.tooBig} events with too many or too large changes were skipped`); }
	if (split.truncated) addError(summary, `Only the first ${MAX_IMPORT_EVENTS} events were read`);
}

/**
 * Sends the events of one .ics file to POST /api/import/calendar in bounded batches. A body is kept under the
 * server's 1 MiB by its encoded length: a batch over it is halved, and a single UID that is still over it is counted as
 * too large. A batch the server cannot take (413, 5xx, network error) is halved and retried down to single events; an
 * event that still fails is counted. A 429 waits (Retry-After, else 2, 4, 8 s) and retries the same batch, never halving
 * it, and after RATE_LIMIT_TRIES stops with the counts so far and `rateLimited` set. Other errors (not signed in, calendar disabled) stop
 * the import. Safe to run again: the server skips what exists.
 */
export async function importCalendarBytes(bytes: Uint8Array, settings: CalendarRunSettings, run: CalendarRunOptions & { post: CalendarPost }): Promise<CalendarRunSummary> {
	const split = splitIcsEvents(bytes);
	const summary = emptySummary();
	summary.events = split.eventCount;
	addSplitLosses(summary, split);
	const source = { name: settings.name, color: settings.color, ...(settings.googleAddress ? { googleAddress: settings.googleAddress } : {}) };
	const options = { reminders: settings.reminders, skipDeclined: settings.skipDeclined };
	// Progress counts events (a series and its changes are several), not UIDs, so "events processed" is exact.
	const total = split.groups.reduce((sum, group) => sum + countEvents(group), 0);
	let done = 0;

	async function halve(batch: string[]): Promise<void> {
		const middle = Math.ceil(batch.length / 2);
		await send(batch.slice(0, middle));
		await send(batch.slice(middle));
	}

	async function send(batch: string[]): Promise<void> {
		if (run.signal?.aborted) { summary.aborted = true; return; }
		if (summary.rateLimited) return;
		const body = { source, options, groups: batch };
		if (bodyBytes(body) > BODY_BYTES) {
			if (batch.length > 1) return halve(batch);
			summary.failed += countEvents(batch[0]);
			addError(summary, "An event with all its changes is too large to upload (over 1 MB)");
			done += countEvents(batch[0]);
			run.onProgress?.(done, total);
			return;
		}
		let result: Awaited<ReturnType<CalendarPost>>;
		for (let attempt = 1; ; attempt++) {
			try {
				result = await run.post(body, run.signal);
			} catch (error) {
				if (run.signal?.aborted) { summary.aborted = true; return; }
				result = { status: 0, data: { error: error instanceof Error ? error.message : String(error) } };
			}
			if (result.status !== 429) break;
			if (attempt >= RATE_LIMIT_TRIES) { summary.rateLimited = true; return; }
			await (run.sleep ?? sleepFor)(result.retryAfterMs ?? RATE_LIMIT_BACKOFF_MS * 2 ** (attempt - 1), run.signal);
			if (run.signal?.aborted) { summary.aborted = true; return; }
		}
		const { status, data } = result;
		if (status === 200) {
			summary.imported += data.imported ?? 0;
			summary.skipped += data.skipped ?? 0;
			summary.simplified += data.simplified ?? 0;
			summary.guessedZone += data.guessedZone ?? 0;
			summary.failed += data.failed ?? 0;
			for (const message of data.errors ?? []) addError(summary, message);
			done += batch.reduce((sum, group) => sum + countEvents(group), 0);
			run.onProgress?.(done, total);
			return;
		}
		if (status !== 0 && status !== 413 && status < 500) throw new Error(data.error ?? `HTTP ${status}`);
		if (batch.length > 1) return halve(batch);
		summary.failed += countEvents(batch[0]);
		addError(summary, data.error ?? `HTTP ${status}`);
		done += countEvents(batch[0]);
		run.onProgress?.(done, total);
	}

	for (const batch of makeBatches(split.groups)) {
		if (run.signal?.aborted) { summary.aborted = true; break; }
		await send(batch);
		if (summary.aborted || summary.rateLimited) break;
	}
	return summary;
}

/** Counts what an import would do, in the browser with the same parser the server uses; posts nothing. */
export async function previewCalendarBytes(bytes: Uint8Array, settings: CalendarRunSettings, userZone: string, run: CalendarRunOptions): Promise<CalendarRunSummary> {
	const split = splitIcsEvents(bytes);
	const summary = emptySummary();
	addSplitLosses(summary, split);
	const options = { userZone, ownAddresses: settings.googleAddress ? [settings.googleAddress.toLowerCase()] : [], reminders: settings.reminders, skipDeclined: settings.skipDeclined };
	const total = split.groups.reduce((sum, group) => sum + countEvents(group), 0);
	let read = 0;
	for (const [index, text] of split.groups.entries()) {
		if (run.signal?.aborted) { summary.aborted = true; break; }
		const group = parseIcsEventGroup(text, options);
		read += countEvents(text);
		summary.events += (group.master ? 1 : 0) + group.overrides.length;
		summary.skipped += group.skipped;
		if (group.master && (group.master.repeat !== "none" || group.simplified)) summary.series++;
		if (group.master && group.simplified) summary.simplified++;
		if (group.guessedZone) summary.guessedZone++;
		summary.failed += group.failures.length;
		for (const message of group.failures) addError(summary, message);
		// Keep the tab responsive on files with tens of thousands of events.
		if (index % 200 === 199) { run.onProgress?.(read, total); await new Promise((resolve) => setTimeout(resolve, 0)); }
	}
	run.onProgress?.(total, total);
	return summary;
}

import { zonedDateFields } from "@/lib/time/utils";

/**
 * Generates VTIMEZONE blocks from the host Intl (ICU) tz database instead of shipping tzdata.
 * Every emitted observance is an observed transition inside a coverage window — explicit blocks
 * only, no RRULE inference (an inferred tail can invent transitions a zone later abolished, and an
 * earlier window's tail can contradict a later window's verified observances; explicit facts cannot
 * collide). Coverage limits: offsets are read from the runtime's tz data (a stale OS/Workers image
 * exports stale offsets) and keep second precision — historical zones like Asia/Colombo need the
 * sub-minute form RFC 5545 permits; a parser that truncates TZOFFSET seconds (ical.js UtcOffset
 * does) drifts by under a minute, which is its bug, not this file's — sub-day offset excursions are
 * not detected (the scan step is a day; none exist in current tzdata) — and past the last coverage
 * window's end the final observance's offset persists forever, so occurrences beyond the horizon
 * feed.ts chooses (see its comment) may drift an hour seasonally. That is the documented limit of a
 * finite file describing an open-ended series.
 */

const DAY = 86_400_000;
// Daily probes: a change that reverts inside a coarser gap (Gaza's week-long post-Ramadan DST
// resumption, Recife's 7-day 2000 window) shows identical offsets at both ends and is missed.
// Excursions shorter than a day are still unsupported — none are known in current tzdata (the
// shortest, Palestine's resumed-DST tail, is just under a week).
const SCAN_STEP = DAY;

// Zones that never change offset; scanning them would only burn the probe budget. IANA's Etc/*
// entries are all fixed (Etc/GMT+N means UTC-N), plus the UTC aliases apps actually store.
const FIXED_ZONE = /^(UTC|Etc\/(UTC|UCT|Universal|Zulu|Greenwich|GMT[+-]?\d*)|GMT[+-]?\d*|Greenwich|Universal|Zulu|UCT)$/;
export function isFixedZone(zone: string): boolean {
	return FIXED_ZONE.test(zone);
}

type Transition = { at: number; from: number; to: number };

/** Wall-clock offset from UTC in ms for `zone` at `at` (epoch ms). */
function offsetMs(zone: string, at: number): number {
	return zonedDateFields(new Date(at), zone).getTime() - at;
}

/** First instant in (lo, hi] where the offset stops being `from`, found to the millisecond; tzdata transitions are second-aligned. */
function findTransition(zone: string, lo: number, hi: number, from: number): number {
	while (hi - lo > 1) {
		const mid = Math.floor((lo + hi) / 2);
		if (offsetMs(zone, mid) === from) lo = mid; else hi = mid;
	}
	return hi;
}

function scanTransitions(zone: string, startMs: number, endMs: number): Transition[] {
	const transitions: Transition[] = [];
	let offset = offsetMs(zone, startMs);
	let at = startMs;
	while (at < endMs) {
		const next = Math.min(at + SCAN_STEP, endMs);
		const nextOffset = offsetMs(zone, next);
		if (nextOffset === offset) { at = next; continue; }
		// The precise instant is the next cursor too: rounding it could keep the old offset and rescan forever.
		const when = findTransition(zone, at, next, offset);
		if (when <= at) throw new Error(`timezone scan for ${zone} did not advance past ${new Date(at).toISOString()}`);
		transitions.push({ at: when, from: offset, to: offsetMs(zone, when) });
		offset = offsetMs(zone, when);
		at = when;
	}
	return transitions;
}

/** ±HHMM for a TZOFFSET value, with optional SS — RFC 5545 permits it and historical zones need it. */
function tzOffset(ms: number): string {
	const seconds = Math.round(Math.abs(ms) / 1000);
	const base = `${ms < 0 ? "-" : "+"}${String(Math.floor(seconds / 3600)).padStart(2, "0")}${String(Math.floor(seconds / 60) % 60).padStart(2, "0")}`;
	return seconds % 60 ? `${base}${String(seconds % 60).padStart(2, "0")}` : base;
}

/** A fake-UTC instant rendered as a local DATE-TIME (no Z). */
function localAt(ms: number): string {
	return new Date(ms).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "");
}

function observance(type: "STANDARD" | "DAYLIGHT", dtstart: string, from: number, to: number): string[] {
	return [`BEGIN:${type}`, `DTSTART:${dtstart}`, `TZOFFSETFROM:${tzOffset(from)}`, `TZOFFSETTO:${tzOffset(to)}`, `END:${type}`];
}

/** The observance blocks a single coverage window contributes, tagged by the instant each takes effect. */
function windowObservances(zone: string, startMs: number, endMs: number): { at: number; block: string[] }[] {
	const transitions = scanTransitions(zone, startMs, endMs);
	if (!transitions.length) {
		const offset = offsetMs(zone, startMs);
		return [{ at: startMs, block: observance("STANDARD", localAt(startMs + offset), offset, offset) }];
	}
	// The period before the first observed transition takes its FROM offset, so instants at or after
	// the window start always resolve. Every other block names the kind it switches into.
	const first = transitions[0];
	const blocks = [{ at: startMs, block: observance(first.to > first.from ? "STANDARD" : "DAYLIGHT", localAt(startMs + first.from), first.from, first.from) }];
	for (const transition of transitions) blocks.push({ at: transition.at, block: observance(transition.to > transition.from ? "DAYLIGHT" : "STANDARD", localAt(transition.at + transition.from), transition.from, transition.to) });
	return blocks;
}

/**
 * The VTIMEZONE subcomponent lines for `zone`, covering `windows` — the disjoint instant ranges the
 * calendar cites, each {startMs, endMs} sorted ascending. Uncited gaps between windows get no
 * observances (nothing resolves there), which is what keeps a repeatUntil-9998 series beside a 2026
 * one from probing millennia. All blocks across the windows merge into one sorted list: every block
 * is an ICU-observed fact, so two windows' contributions can never contradict.
 */
export function vtimezoneLines(zone: string, windows: { startMs: number; endMs: number }[]): string[] {
	const lines = ["BEGIN:VTIMEZONE", `TZID:${zone}`];
	if (isFixedZone(zone)) {
		// One offset read, not a scan: Etc zones are fixed but nonzero (Etc/GMT+5 is UTC-05:00).
		const offset = offsetMs(zone, windows[0].startMs);
		lines.push(...observance("STANDARD", localAt(windows[0].startMs + offset), offset, offset), "END:VTIMEZONE");
		return lines;
	}
	const blocks = windows.flatMap(({ startMs, endMs }) => windowObservances(zone, startMs, endMs));
	blocks.sort((a, b) => a.at - b.at);
	let previous = -1;
	for (const { at, block } of blocks) {
		if (at === previous) continue;
		previous = at;
		lines.push(...block);
	}
	// Loud documentation: this block was generated to cover the instants the file cites; past the
	// last coverage boundary the final observance's offset persists (RFC 5545) rather than the
	// zone's real future rules.
	lines.push(`X-MAILFLARE-COVERAGE-END:${new Date(windows[windows.length - 1].endMs).toISOString()}`, "END:VTIMEZONE");
	return lines;
}

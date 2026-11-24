import { zonedDateFields } from "@/lib/time/utils";

/**
 * Generates VTIMEZONE blocks from the host Intl (ICU) tz database instead of shipping tzdata.
 * The window only needs to cover the instants the calendar file emits: transitions inside it are
 * found by scanning, a stable yearly pattern (2nd-Sunday-in-March style) becomes an RRULE observance,
 * and anything else — zones that change offset irregularly, or a rule adopted mid-window — is written
 * as one-off observances, which stay exact within the window. Coverage limits: offsets are read from
 * the runtime's tz data (a stale OS/Workers image exports stale rules) and keep second precision —
 * historical zones like Asia/Colombo need the sub-minute form RFC 5545 permits; a parser that
 * truncates TZOFFSET seconds (ical.js UtcOffset does) drifts by under a minute, which is its bug, not
 * this file's — sub-day offset excursions are not detected (the scan step is a day; none exist in
 * current tzdata) — and an irregular zone's one-offs stop at the window end, so an open-ended series
 * there holds the last offset beyond it.
 */

const DAY = 86_400_000;
// Daily probes: a change that reverts inside a coarser gap (Gaza's week-long post-Ramadan DST
// resumption, Recife's 7-day 2000 window) shows identical offsets at both ends and is missed.
// Excursions shorter than a day are still unsupported — none are known in current tzdata (the
// shortest, Palestine's resumed-DST tail, is just under a week).
const SCAN_STEP = DAY;

const WEEKDAYS = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];

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

function daysInMonth(year: number, month: number): number {
	return new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
}

type YearlyRule = { month: number; weekday: number; ordinal: number; hour: number; minute: number; second: number };

function ruleFields(localMs: number): { month: number; weekday: number; ordinal: number; last: boolean; hour: number; minute: number; second: number } {
	const date = new Date(localMs);
	const dim = daysInMonth(date.getUTCFullYear(), date.getUTCMonth());
	return { month: date.getUTCMonth(), weekday: date.getUTCDay(), ordinal: Math.ceil(date.getUTCDate() / 7), last: date.getUTCDate() + 7 > dim, hour: date.getUTCHours(), minute: date.getUTCMinutes(), second: date.getUTCSeconds() };
}

function matchesRule(localMs: number, rule: YearlyRule): boolean {
	const fields = ruleFields(localMs);
	if (fields.month !== rule.month || fields.weekday !== rule.weekday || fields.hour !== rule.hour || fields.minute !== rule.minute || fields.second !== rule.second) return false;
	return rule.ordinal === -1 ? fields.last : fields.ordinal === rule.ordinal;
}

/** The local instant (fake-UTC ms) the rule predicts for `year`; a 5th weekday may not exist that year. */
function predictedLocal(year: number, rule: YearlyRule): number | null {
	const dim = daysInMonth(year, rule.month);
	let date: number;
	if (rule.ordinal === -1) {
		const lastDow = new Date(Date.UTC(year, rule.month, dim)).getUTCDay();
		date = dim - ((lastDow - rule.weekday + 7) % 7);
	} else {
		const firstDow = new Date(Date.UTC(year, rule.month, 1)).getUTCDay();
		date = 1 + ((rule.weekday - firstDow + 7) % 7) + (rule.ordinal - 1) * 7;
		if (date > dim) return null;
	}
	return Date.UTC(year, rule.month, date, rule.hour, rule.minute, rule.second);
}

/**
 * The yearly rule the tail of `transitions` proves, with its anchor index. The last three decide the
 * candidates — same month, weekday and wall time, plus either a shared ordinal or every date being the
 * last such weekday of its month (a 4th-that-is-also-last streak prefers -1: last-weekday rules
 * dominate real zones, and a wrong 4SU silently mis-times 5-Sunday years). The emitted tail is the
 * contiguous run matching the rule AND sharing the last transition's offsets — one RRULE can only
 * describe one from/to pair. A candidate is then rejected unless every instant it predicts inside
 * the scanned window was actually observed: a zone that abolished or changed its rule (Mexico stopped
 * DST in 2022) would otherwise keep inventing transitions past its last real one.
 */
function yearlyRule(transitions: Transition[], endMs: number): { rule: YearlyRule; anchorIndex: number } | null {
	if (transitions.length < 3) return null;
	const tail = transitions.slice(-3).map((transition) => ruleFields(transition.at + transition.from));
	const [last] = tail;
	if (!tail.every((fields) => fields.month === last.month && fields.weekday === last.weekday && fields.hour === last.hour && fields.minute === last.minute && fields.second === last.second)) return null;
	const base = { month: last.month, weekday: last.weekday, hour: last.hour, minute: last.minute, second: last.second };
	const candidates: YearlyRule[] = [];
	if (tail.every((fields) => fields.last)) candidates.push({ ...base, ordinal: -1 });
	if (tail.every((fields) => fields.ordinal === last.ordinal)) candidates.push({ ...base, ordinal: last.ordinal });
	const { from, to } = transitions[transitions.length - 1];
	for (const rule of candidates) {
		let anchorIndex = transitions.length;
		while (anchorIndex > 0 && matchesRule(transitions[anchorIndex - 1].at + transitions[anchorIndex - 1].from, rule)
			&& transitions[anchorIndex - 1].from === from && transitions[anchorIndex - 1].to === to) anchorIndex--;
		const years = new Set(transitions.slice(anchorIndex).map((transition) => new Date(transition.at + transition.from).getUTCFullYear()));
		let verified = true;
		for (let year = new Date(transitions[anchorIndex].at + transitions[anchorIndex].from).getUTCFullYear(); ; year++) {
			const predicted = predictedLocal(year, rule);
			if (predicted === null) continue; // No such weekday that year: the rule legitimately skips it.
			if (predicted - from > endMs) break; // Predictions past the window need no observation.
			if (!years.has(year)) { verified = false; break; }
		}
		if (verified) return { rule, anchorIndex };
	}
	return null;
}

function observance(type: "STANDARD" | "DAYLIGHT", dtstart: string, from: number, to: number, rule: YearlyRule | null): string[] {
	const lines = [`BEGIN:${type}`, `DTSTART:${dtstart}`, `TZOFFSETFROM:${tzOffset(from)}`, `TZOFFSETTO:${tzOffset(to)}`];
	if (rule) lines.push(`RRULE:FREQ=YEARLY;BYMONTH=${rule.month + 1};BYDAY=${rule.ordinal}${WEEKDAYS[rule.weekday]}`);
	lines.push(`END:${type}`);
	return lines;
}

/** The VTIMEZONE subcomponent lines for `zone`, covering every transition inside [startMs, endMs]. */
export function vtimezoneLines(zone: string, startMs: number, endMs: number): string[] {
	const lines = ["BEGIN:VTIMEZONE", `TZID:${zone}`];
	const transitions = scanTransitions(zone, startMs, endMs);
	if (!transitions.length) {
		const offset = offsetMs(zone, startMs);
		lines.push(...observance("STANDARD", localAt(startMs), offset, offset, null), "END:VTIMEZONE");
		return lines;
	}
	// The period before the first observed transition takes its FROM offset, so instants at or after
	// the window start always resolve. Each observance below is of the kind it switches into.
	const first = transitions[0];
	const preamble = first.to > first.from ? "STANDARD" : "DAYLIGHT";
	lines.push(...observance(preamble, localAt(startMs + first.from), first.from, first.from, null));
	const oneOffs: { at: number; block: string[] }[] = [];
	const rules: { at: number; block: string[] }[] = [];
	for (const type of ["STANDARD", "DAYLIGHT"] as const) {
		const group = transitions.filter((transition) => (transition.to > transition.from) === (type === "DAYLIGHT"));
		if (!group.length) continue;
		const inferred = yearlyRule(group, endMs);
		// Only the verified tail matching the inferred rule carries the RRULE (one block anchored on its
		// first match); every earlier transition of the kind is written as an explicit observance.
		const anchorIndex = inferred?.anchorIndex ?? group.length;
		group.slice(0, anchorIndex).forEach((transition) => oneOffs.push({ at: transition.at, block: observance(type, localAt(transition.at + transition.from), transition.from, transition.to, null) }));
		if (inferred) {
			const anchor = group[anchorIndex];
			rules.push({ at: anchor.at, block: observance(type, localAt(anchor.at + anchor.from), anchor.from, anchor.to, inferred.rule) });
		}
	}
	oneOffs.sort((a, b) => a.at - b.at);
	rules.sort((a, b) => a.at - b.at);
	for (const { block } of [...oneOffs, ...rules]) lines.push(...block);
	lines.push("END:VTIMEZONE");
	return lines;
}

import { zonedDateFields } from "@/lib/time/utils";

/**
 * Generates VTIMEZONE blocks from the host Intl (ICU) tz database instead of shipping tzdata.
 * The window only needs to cover the instants the calendar file emits: transitions inside it are
 * found by scanning, a stable yearly pattern (2nd-Sunday-in-March style) becomes an RRULE observance,
 * and anything else — zones that change offset irregularly, or a rule adopted mid-window — is written
 * as one-off observances, which stay exact within the window. Coverage limits: offsets are read from
 * the runtime's tz data (a stale OS/Workers image exports stale rules), sub-minute historical offsets
 * are rounded to the minute, and an irregular zone's one-offs stop at the window end, so an open-ended
 * series in such a zone resolves with the last observed offset beyond it.
 */

const MINUTE = 60_000;
const DAY = 86_400_000;
const SCAN_STEP = 7 * DAY;

const WEEKDAYS = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];

type Transition = { at: number; from: number; to: number };

/** Wall-clock offset from UTC in ms for `zone` at `at` (epoch ms). */
function offsetMs(zone: string, at: number): number {
	return zonedDateFields(new Date(at), zone).getTime() - at;
}

/** First instant in (lo, hi] where the offset stops being `from`; transitions are minute-aligned. */
function findTransition(zone: string, lo: number, hi: number, from: number): number {
	while (hi - lo > 1000) {
		const mid = Math.floor((lo + hi) / 2000) * 1000;
		if (offsetMs(zone, mid) === from) lo = mid; else hi = mid;
	}
	return Math.round(hi / MINUTE) * MINUTE;
}

function scanTransitions(zone: string, startMs: number, endMs: number): Transition[] {
	const transitions: Transition[] = [];
	let offset = offsetMs(zone, startMs);
	let at = startMs;
	while (at < endMs) {
		const next = Math.min(at + SCAN_STEP, endMs);
		const nextOffset = offsetMs(zone, next);
		if (nextOffset === offset) { at = next; continue; }
		const when = findTransition(zone, at, next, offset);
		transitions.push({ at: when, from: offset, to: offsetMs(zone, when) });
		offset = offsetMs(zone, when);
		at = when;
	}
	return transitions;
}

/** ±HHMM for a TZOFFSET value; every post-war transition is minute-aligned. */
function tzOffset(ms: number): string {
	const minutes = Math.round(Math.abs(ms) / MINUTE);
	return `${ms < 0 ? "-" : "+"}${String(Math.floor(minutes / 60)).padStart(2, "0")}${String(minutes % 60).padStart(2, "0")}`;
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

/**
 * The yearly rule the last three transitions of one kind share — same month, weekday, wall time and
 * nth-position (a fifth-weekday-that-is-last reads as -1). Null when fewer than three exist or they disagree.
 */
function yearlyRule(transitions: Transition[]): YearlyRule | null {
	if (transitions.length < 3) return null;
	const recent = transitions.slice(-3).map((transition) => ruleFields(transition.at + transition.from));
	const [first] = recent;
	if (!recent.every((fields) => fields.month === first.month && fields.weekday === first.weekday && fields.hour === first.hour && fields.minute === first.minute && fields.second === first.second)) return null;
	if (recent.every((fields) => fields.ordinal === first.ordinal)) return { month: first.month, weekday: first.weekday, ordinal: first.ordinal, hour: first.hour, minute: first.minute, second: first.second };
	if (recent.every((fields) => fields.last)) return { month: first.month, weekday: first.weekday, ordinal: -1, hour: first.hour, minute: first.minute, second: first.second };
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
		const rule = yearlyRule(group);
		// Only the contiguous tail matching the detected rule carries the RRULE (one block anchored on
		// its first match); every earlier transition of the kind is a one-off.
		let firstRuleIndex = group.length;
		if (rule) while (firstRuleIndex > 0 && matchesRule(group[firstRuleIndex - 1].at + group[firstRuleIndex - 1].from, rule)) firstRuleIndex--;
		group.slice(0, firstRuleIndex).forEach((transition) => oneOffs.push({ at: transition.at, block: observance(type, localAt(transition.at + transition.from), transition.from, transition.to, null) }));
		if (rule && firstRuleIndex < group.length) {
			const anchor = group[firstRuleIndex];
			rules.push({ at: anchor.at, block: observance(type, localAt(anchor.at + anchor.from), anchor.from, anchor.to, rule) });
		}
	}
	oneOffs.sort((a, b) => a.at - b.at);
	rules.sort((a, b) => a.at - b.at);
	for (const { block } of [...oneOffs, ...rules]) lines.push(...block);
	lines.push("END:VTIMEZONE");
	return lines;
}

import { zonedDateFields } from "@/lib/time/utils";

/** Years before and after the current one that every VTIMEZONE covers; a series' own start year is merged in on top. */
const YEARS_BEFORE = 1;
const YEARS_AFTER = 10;
const SCAN_STEP = 7 * 86_400_000;
const CACHE_LIMIT = 256;
/** Transitions of one span of years, per zone and first year: the shared window and the start years seen. */
const spans = new Map<string, { first: number; list: Transition[] }>();
/** Finished lines per zone, current year and start year. */
const cache = new Map<string, string[]>();

const offsetAt = (instant: number, zone: string) => zonedDateFields(new Date(instant), zone).getTime() - instant;

function formatOffset(ms: number): string {
	const sign = ms < 0 ? "-" : "+";
	const seconds = Math.round(Math.abs(ms) / 1000);
	const pad = (value: number) => String(value).padStart(2, "0");
	return `${sign}${pad(Math.floor(seconds / 3600))}${pad(Math.floor((seconds % 3600) / 60))}${seconds % 60 ? pad(seconds % 60) : ""}`;
}

/** A local wall time such as 20261101T020000, from the UTC fields of an instant shifted by the zone offset. */
const wall = (instant: number, offset: number) => new Date(instant + offset).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "");

type Transition = { at: number; from: number; to: number };

function transitions(zone: string, fromYear: number, years: number): { first: number; list: Transition[] } {
	const start = Date.UTC(fromYear, 0, 1);
	const end = Date.UTC(fromYear + years + 1, 0, 1);
	const first = offsetAt(start, zone);
	const list: Transition[] = [];
	let previous = start;
	let previousOffset = first;
	for (let at = start + SCAN_STEP; at <= end + SCAN_STEP; at += SCAN_STEP) {
		const offset = offsetAt(at, zone);
		if (offset !== previousOffset) {
			// Offsets change on whole minutes, so bisect minutes between the two samples.
			let low = previous;
			let high = at;
			while (high - low > 60_000) {
				const middle = low + Math.floor((high - low) / 120_000) * 60_000;
				if (offsetAt(middle, zone) === previousOffset) low = middle;
				else high = middle;
			}
			list.push({ at: high, from: previousOffset, to: offset });
		}
		previous = at;
		previousOffset = offset;
	}
	return { first, list: list.filter((transition) => transition.at < end) };
}

function span(zone: string, fromYear: number, years: number) {
	const key = `${zone}|${fromYear}|${years}`;
	let hit = spans.get(key);
	if (!hit) {
		if (spans.size >= CACHE_LIMIT) spans.clear();
		hit = transitions(zone, fromYear, years);
		spans.set(key, hit);
	}
	return hit;
}

/**
 * The lines of a VTIMEZONE for an IANA zone (RFC 5545 3.6.5): a base observance for the time before the first
 * transition, then one STANDARD or DAYLIGHT component per kind of switch with its dates as local RDATEs. Found by
 * sampling `Intl` offsets (the same arithmetic as `zonedDateFields`). Covers a fixed window, the year before
 * `currentYear` through ten years after, which is computed once per zone and shared by every series; the year the
 * series starts in is merged in when it falls outside the window, so its DTSTART resolves to the right offset.
 * Years between a long-running series' start and the window are not listed. Cached. Throws for a zone `Intl` does not know.
 */
export function buildVtimezone(zone: string, startYear: number, currentYear = new Date().getUTCFullYear()): string[] {
	const year = Math.min(Math.max(Math.trunc(startYear), 1970), 2100);
	const key = `${zone}|${currentYear}|${year}`;
	const hit = cache.get(key);
	if (hit) return hit;
	const from = currentYear - YEARS_BEFORE;
	const to = currentYear + YEARS_AFTER;
	const window = span(zone, from, to - from);
	let { first, list } = window;
	if (year < from || year > to) {
		const own = span(zone, year, 0);
		list = (year < from ? [...own.list, ...list] : [...list, ...own.list]).sort((a, b) => a.at - b.at);
		if (year < from) first = own.first;
	}
	const lines = ["BEGIN:VTIMEZONE", `TZID:${zone}`, "BEGIN:STANDARD", "DTSTART:19000101T000000", `TZOFFSETFROM:${formatOffset(first)}`, `TZOFFSETTO:${formatOffset(first)}`, "END:STANDARD"];
	const groups = new Map<string, Transition[]>();
	for (const transition of list) {
		const group = `${transition.from}|${transition.to}`;
		groups.set(group, [...(groups.get(group) ?? []), transition]);
	}
	for (const members of [...groups.values()].sort((a, b) => a[0].at - b[0].at)) {
		const { from, to } = members[0];
		const dates = members.map((member) => wall(member.at, from));
		lines.push(to > from ? "BEGIN:DAYLIGHT" : "BEGIN:STANDARD", `DTSTART:${dates[0]}`, `TZOFFSETFROM:${formatOffset(from)}`, `TZOFFSETTO:${formatOffset(to)}`, `RDATE:${dates.join(",")}`, to > from ? "END:DAYLIGHT" : "END:STANDARD");
	}
	lines.push("END:VTIMEZONE");
	if (cache.size >= CACHE_LIMIT) cache.clear();
	cache.set(key, lines);
	return lines;
}

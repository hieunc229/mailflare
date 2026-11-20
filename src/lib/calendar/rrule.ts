import { dateFromZonedFields, normalizeTimeZone, zonedDateFields } from "@/lib/time/utils";

/**
 * RFC 5545 recurrence rules for events whose repeat the repeat_* columns cannot express (`repeat = "custom"`),
 * plus the conversion between the two forms. Pure: no I/O, safe for the client bundle.
 *
 * Occurrences keep their local clock time across daylight saving changes, like the legacy expanders: the rule is
 * stepped on calendar dates in the event's zone and each date gets DTSTART's wall time.
 */

const DAY = 86_400_000;
/**
 * Work budget per expansion, in candidate days looked at (a daily rule steps one per period, a yearly one 366): about 55
 * years of any frequency. A rule that would need more returns the occurrences found so far instead of spinning.
 */
const MAX_WORK = 20_000;
const PERIOD_WORK = { DAILY: 1, WEEKLY: 7, MONTHLY: 31, YEARLY: 366 } as const;
/** Longest month per number: February counts 29 so a leap-day rule is not rejected. */
const MONTH_LENGTH = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
/** A zone offset is never beyond 14 hours; 15 gives a margin for "this wall time is clearly before that instant". */
const OFFSET_MARGIN = 15 * 3_600_000;
const MAX_RULE_LENGTH = 1000;
const DAY_CODES = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];
const FREQS = ["DAILY", "WEEKLY", "MONTHLY", "YEARLY"] as const;

export type Rrule = {
	freq: (typeof FREQS)[number];
	interval: number;
	count: number | null;
	/** Inclusive UTC instant (epoch ms), from a date-time UNTIL. */
	untilMs: number | null;
	/** Inclusive whole day (days since the epoch), from a date-only UNTIL. */
	untilDay: number | null;
	/** `ordinal` is 0 for a plain weekday, else the nth (negative: from the end) of the month or year. */
	byDay: { ordinal: number; day: number }[];
	byMonthDay: number[];
	byMonth: number[];
	bySetPos: number[];
	wkst: number;
	/** The legacy monthly repeat moves day 29-31 to the month's last day; RFC 5545 skips such months. Set only by legacyRrule. */
	clampMonthDay?: boolean;
};

/** The repeat_* columns of a calendar row. `repeatUntil` is exclusive, as the legacy expanders read it. */
export type LegacyRepeat = { repeat: "none" | "daily" | "weekly" | "monthly" | "weekdays"; repeatDays: number[]; repeatAnchorDay: number | null; repeatUntil: Date | null };

export type RecurringEvent = {
	startsAt: Date;
	endsAt: Date;
	timeZone?: string | null;
	repeat: string;
	rrule?: string | null;
	repeatDays?: string;
	repeatAnchorDay?: number | null;
	repeatUntil?: Date | null;
	excludedOccurrences?: string;
};

function integer(value: string, min: number, max: number): number | null {
	if (!/^[+-]?\d{1,4}$/.test(value)) return null;
	const number = Number(value);
	return Math.abs(number) >= min && Math.abs(number) <= max ? number : null;
}

function list(value: string, parse: (item: string) => number | null): number[] | null {
	const items = value.split(",").map(parse);
	return items.length && items.every((item) => item !== null) ? [...new Set(items as number[])] : null;
}

/**
 * Parses the supported subset: FREQ DAILY/WEEKLY/MONTHLY/YEARLY, INTERVAL 1-999, COUNT 1-5000, UNTIL, BYDAY (ordinals
 * only for MONTHLY/YEARLY), BYMONTHDAY, BYMONTH, BYSETPOS (MONTHLY/YEARLY) and WKST. Anything else, including sub-daily
 * frequencies, BYHOUR, BYMINUTE, BYSECOND, BYYEARDAY and BYWEEKNO, returns null: the caller keeps the rule only in the
 * stored body and shows one occurrence. `zone` reads a floating date-time UNTIL.
 */
export function parseRrule(value: string, zone?: string | null): Rrule | null {
	if (!value || value.length > MAX_RULE_LENGTH) return null;
	const parts = new Map<string, string>();
	for (const part of value.replace(/^RRULE:/i, "").split(";")) {
		const eq = part.indexOf("=");
		const key = part.slice(0, eq).trim().toUpperCase();
		if (eq < 1 || parts.has(key)) return null;
		parts.set(key, part.slice(eq + 1).trim().toUpperCase());
	}
	const known = new Set(["FREQ", "INTERVAL", "COUNT", "UNTIL", "BYDAY", "BYMONTHDAY", "BYMONTH", "BYSETPOS", "WKST"]);
	if ([...parts.keys()].some((key) => !known.has(key))) return null;
	const freq = FREQS.find((candidate) => candidate === parts.get("FREQ"));
	if (!freq) return null;
	const rule: Rrule = { freq, interval: 1, count: null, untilMs: null, untilDay: null, byDay: [], byMonthDay: [], byMonth: [], bySetPos: [], wkst: 1 };
	if (parts.has("INTERVAL")) { const interval = integer(parts.get("INTERVAL")!, 1, 999); if (!interval || interval < 0) return null; rule.interval = interval; }
	if (parts.has("COUNT")) { const count = integer(parts.get("COUNT")!, 1, 5000); if (!count || count < 0) return null; rule.count = count; }
	if (parts.has("UNTIL") && !parseUntil(rule, parts.get("UNTIL")!, normalizeTimeZone(zone))) return null;
	const monthly = freq === "MONTHLY" || freq === "YEARLY";
	if (parts.has("BYDAY")) {
		const byDay: Rrule["byDay"] = [];
		for (const item of parts.get("BYDAY")!.split(",")) {
			const match = /^([+-]?\d{1,2})?(SU|MO|TU|WE|TH|FR|SA)$/.exec(item);
			if (!match) return null;
			const ordinal = match[1] ? Number(match[1]) : 0;
			if (match[1] && (!monthly || ordinal === 0 || Math.abs(ordinal) > 53)) return null;
			byDay.push({ ordinal, day: DAY_CODES.indexOf(match[2]) });
		}
		rule.byDay = byDay;
	}
	if (parts.has("BYMONTHDAY")) {
		if (freq === "WEEKLY") return null;
		const days = list(parts.get("BYMONTHDAY")!, (item) => integer(item, 1, 31));
		if (!days) return null;
		rule.byMonthDay = days;
	}
	if (parts.has("BYMONTH")) {
		const months = list(parts.get("BYMONTH")!, (item) => { const month = integer(item, 1, 12); return month && month > 0 ? month : null; });
		if (!months) return null;
		rule.byMonth = months;
	}
	if (parts.has("BYSETPOS")) {
		if (!monthly) return null;
		const positions = list(parts.get("BYSETPOS")!, (item) => integer(item, 1, 366));
		if (!positions) return null;
		rule.bySetPos = positions;
	}
	if (parts.has("WKST")) {
		const day = DAY_CODES.indexOf(parts.get("WKST")!);
		if (day < 0) return null;
		rule.wkst = day;
	}
	return isPossible(rule) ? rule : null;
}

const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);

/**
 * False for rules that are valid text but can never produce a date (or ask for a position past the biggest set the rule
 * can build), so the expander never has to search for them: the caller shows such an event once.
 */
function isPossible(rule: Rrule): boolean {
	// An ordinal weekday counts inside a month, except for a YEARLY rule with neither BYMONTH nor BYMONTHDAY, where it counts inside the year.
	const wholeYear = rule.freq === "YEARLY" && !rule.byMonth.length && !rule.byMonthDay.length;
	if (rule.byDay.some(({ ordinal }) => Math.abs(ordinal) > (wholeYear ? 53 : 5))) return false;
	// A day number longer than every listed month (Feb 30, Apr 31) never matches.
	if (rule.byMonth.length && rule.byMonthDay.length && !rule.byMonth.some((month) => rule.byMonthDay.some((day) => Math.abs(day) <= MONTH_LENGTH[month - 1]))) return false;
	if (rule.bySetPos.length) {
		const perMonth = rule.byMonthDay.length ? Math.min(31, rule.byMonthDay.length) : rule.byDay.length ? Math.min(31, sum(rule.byDay.map(({ ordinal }) => (ordinal ? 1 : 5)))) : 1;
		const bound = rule.freq === "MONTHLY" ? perMonth
			: wholeYear && rule.byDay.length ? Math.min(366, sum(rule.byDay.map(({ ordinal }) => (ordinal ? 1 : 53))))
			: Math.min(366, (rule.byMonth.length || (rule.byMonthDay.length ? 12 : 1)) * perMonth);
		if (rule.bySetPos.some((position) => Math.abs(position) > bound)) return false;
	}
	return true;
}

function parseUntil(rule: Rrule, value: string, zone: string): boolean {
	const match = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/.exec(value);
	if (!match) return false;
	const [year, month, day] = [Number(match[1]), Number(match[2]) - 1, Number(match[3])];
	if (!match[4]) { rule.untilDay = Date.UTC(year, month, day) / DAY; return true; }
	const fields = new Date(Date.UTC(year, month, day, Number(match[4]), Number(match[5]), Number(match[6])));
	rule.untilMs = (match[7] ? fields : dateFromZonedFields(fields, zone)).getTime();
	return Number.isFinite(rule.untilMs);
}

const daysInMonth = (year: number, month: number) => new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
const dayNumber = (year: number, month: number, day: number) => Date.UTC(year, month, day) / DAY;
const weekday = (day: number) => ((day % 7) + 11) % 7;

/** Day-of-month numbers of `month` that satisfy the rule's BYMONTHDAY and BYDAY, or the start's own day when neither is given. */
function monthDays(rule: Rrule, year: number, month: number, startDay: number): number[] {
	const last = daysInMonth(year, month);
	const days = new Set<number>();
	if (rule.byMonthDay.length) {
		for (const day of rule.byMonthDay) { const resolved = day > 0 ? (rule.clampMonthDay ? Math.min(day, last) : day) : last + day + 1; if (resolved >= 1 && resolved <= last) days.add(resolved); }
	} else if (!rule.byDay.length) {
		if (startDay <= last) days.add(startDay);
	}
	if (rule.byDay.length) {
		const matching = new Set<number>();
		for (const { ordinal, day } of rule.byDay) {
			const all: number[] = [];
			for (let date = 1; date <= last; date++) if (weekday(dayNumber(year, month, date)) === day) all.push(date);
			if (!ordinal) all.forEach((date) => matching.add(date));
			else { const picked = all[ordinal > 0 ? ordinal - 1 : all.length + ordinal]; if (picked) matching.add(picked); }
		}
		if (rule.byMonthDay.length) for (const day of [...days]) { if (!matching.has(day)) days.delete(day); }
		else matching.forEach((date) => days.add(date));
	}
	return [...days].sort((a, b) => a - b);
}

/** The nth (or last) listed weekday of a whole year, for a YEARLY BYDAY with an ordinal and no BYMONTH. */
function yearDays(rule: Rrule, year: number): number[] {
	const first = dayNumber(year, 0, 1);
	const length = dayNumber(year + 1, 0, 1) - first;
	const found = new Set<number>();
	for (const { ordinal, day } of rule.byDay) {
		const all: number[] = [];
		for (let offset = 0; offset < length; offset++) if (weekday(first + offset) === day) all.push(first + offset);
		if (!ordinal) all.forEach((date) => found.add(date));
		else { const picked = all[ordinal > 0 ? ordinal - 1 : all.length + ordinal]; if (picked !== undefined) found.add(picked); }
	}
	return [...found].sort((a, b) => a - b);
}

function setPositions(days: number[], positions: number[]): number[] {
	if (!positions.length) return days;
	return [...new Set(positions.map((position) => days[position > 0 ? position - 1 : days.length + position]).filter((day) => day !== undefined))].sort((a, b) => a - b);
}

/** Candidate days (epoch days, ascending) of period `index`, before the start and UNTIL cuts. */
function periodDays(rule: Rrule, start: { year: number; month: number; day: number; epochDay: number }, index: number): number[] {
	const step = index * rule.interval;
	if (rule.freq === "DAILY" || rule.freq === "WEEKLY") {
		let days: number[];
		if (rule.freq === "DAILY") days = [start.epochDay + step];
		else {
			const weekStart = start.epochDay - ((weekday(start.epochDay) - rule.wkst + 7) % 7) + 7 * step;
			const wanted = rule.byDay.length ? rule.byDay.map((item) => item.day) : [weekday(start.epochDay)];
			days = [...new Set(wanted)].map((day) => weekStart + ((day - rule.wkst + 7) % 7)).sort((a, b) => a - b);
		}
		return days.filter((day) => {
			const date = new Date(day * DAY);
			return (!rule.byMonth.length || rule.byMonth.includes(date.getUTCMonth() + 1))
				&& (rule.freq === "WEEKLY" || !rule.byDay.length || rule.byDay.some((item) => item.day === weekday(day)))
				&& (!rule.byMonthDay.length || rule.byMonthDay.some((value) => value > 0 ? value === date.getUTCDate() : daysInMonth(date.getUTCFullYear(), date.getUTCMonth()) + value + 1 === date.getUTCDate()));
		});
	}
	const monthIndex = rule.freq === "MONTHLY" ? start.year * 12 + start.month + step : null;
	if (monthIndex !== null) {
		const year = Math.floor(monthIndex / 12);
		const month = monthIndex % 12;
		if (rule.byMonth.length && !rule.byMonth.includes(month + 1)) return [];
		return setPositions(monthDays(rule, year, month, start.day).map((day) => dayNumber(year, month, day)), rule.bySetPos);
	}
	const year = start.year + step;
	let days: number[];
	if (!rule.byMonth.length && !rule.byMonthDay.length && rule.byDay.length) days = yearDays(rule, year);
	else {
		const months = rule.byMonth.length ? rule.byMonth.map((month) => month - 1) : rule.byMonthDay.length ? Array.from({ length: 12 }, (_, month) => month) : [start.month];
		days = [...new Set(months)].sort((a, b) => a - b).flatMap((month) => monthDays(rule, year, month, start.day).map((day) => dayNumber(year, month, day)));
	}
	return setPositions(days, rule.bySetPos);
}

type Walk = { starts: Date[]; /** True when the work budget ended the walk, so later occurrences may exist. */ exhausted: boolean };

function walk(rule: Rrule, dtstart: Date, zone: string, from: Date, to: Date, max: number): Walk {
	const timeZone = normalizeTimeZone(zone);
	const fields = zonedDateFields(dtstart, timeZone);
	const start = { year: fields.getUTCFullYear(), month: fields.getUTCMonth(), day: fields.getUTCDate(), epochDay: Math.floor(fields.getTime() / DAY) };
	const timeOfDay = fields.getTime() - start.epochDay * DAY;
	// Whole days are compared first, so only days near the window pay for a zone conversion.
	const firstDay = Math.floor(zonedDateFields(from, timeZone).getTime() / DAY) - 1;
	const lastDay = Math.floor(zonedDateFields(to, timeZone).getTime() / DAY) + 1;
	const result: Date[] = [];
	const done = (exhausted = false): Walk => ({ starts: result, exhausted });
	let emitted = 0;
	// Without COUNT nothing before `from` matters, so skip whole periods instead of stepping from DTSTART.
	let index = 0;
	if (rule.count === null) {
		const ahead = Math.max(0, Math.floor((from.getTime() - dtstart.getTime()) / DAY));
		const periods = rule.freq === "DAILY" ? ahead : rule.freq === "WEEKLY" ? Math.floor(ahead / 7) : rule.freq === "MONTHLY" ? Math.floor(ahead / 31) : Math.floor(ahead / 366);
		index = Math.max(0, Math.floor(periods / rule.interval) - 1);
	}
	const accept = (at: Date): boolean | "stop" => {
		if (at.getTime() >= to.getTime()) return "stop";
		if (at.getTime() >= from.getTime()) { result.push(at); if (result.length >= max) return "stop"; }
		return true;
	};
	if (index === 0) {
		emitted++;
		if (accept(dtstart) === "stop") return done();
	}
	// A COUNT walk has to reach the COUNTth occurrence to know where the series ends, so its budget grows with COUNT (at most 5000).
	const budget = Math.max(MAX_WORK, (rule.count ?? 0) * PERIOD_WORK[rule.freq]);
	for (let work = 0; ; index++) {
		if ((work += PERIOD_WORK[rule.freq]) > budget) return done(true);
		for (const day of periodDays(rule, start, index)) {
			if (day <= start.epochDay) continue;
			if (day > lastDay || (rule.untilDay !== null && day > rule.untilDay)) return done();
			const wall = day * DAY + timeOfDay;
			if (day < firstDay && (rule.untilMs === null || wall + OFFSET_MARGIN <= rule.untilMs)) {
				// Clearly before the window and before UNTIL: it only counts toward COUNT.
				if (rule.count !== null && ++emitted > rule.count) return done();
				continue;
			}
			const at = dateFromZonedFields(new Date(wall), timeZone);
			if (rule.untilMs !== null && at.getTime() > rule.untilMs) return done();
			if (rule.count !== null && ++emitted > rule.count) return done();
			if (accept(at) === "stop") return done();
		}
	}
}

/**
 * Starts of the occurrences in [from, to), at most `max`, ascending. `dtstart` is always the first instance (RFC 5545
 * 3.8.5.3) even when the rule would not produce it. EXDATEs are not applied here. The walk stops at a fixed work budget
 * (MAX_WORK), so a rule that is almost never true returns the occurrences found by then.
 */
export function expandRrule(rule: Rrule, dtstart: Date, zone: string, from: Date, to: Date, max = 500): Date[] {
	return walk(rule, dtstart, zone, from, to, max).starts;
}

/** The last start a walk found for a rule that ends (COUNT or UNTIL), null when it is endless. `exhausted`: the work budget ran out, so the series may go on past `last`. */
function lastStart(rule: Rrule, dtstart: Date, zone: string): { last: Date | null; exhausted: boolean } {
	if (rule.count === null && rule.untilMs === null && rule.untilDay === null) return { last: null, exhausted: false };
	const { starts, exhausted } = walk(rule, dtstart, zone, dtstart, new Date(dtstart.getTime() + 400 * 366 * DAY), Infinity);
	return { last: starts[starts.length - 1] ?? dtstart, exhausted };
}

/** True when the series (a stored RRULE value) has no occurrence at or after `instant`. A rule that cannot be read is one occurrence. */
export function rruleEndedBefore(value: string, dtstart: Date, zone: string | null | undefined, instant: Date): boolean {
	const timeZone = normalizeTimeZone(zone);
	const rule = parseRrule(value, timeZone);
	if (!rule) return dtstart < instant;
	const { last, exhausted } = lastStart(rule, dtstart, timeZone);
	return !exhausted && last !== null && last < instant;
}

/** The legacy columns as a rule, so both forms expand through one path. `repeatUntil` is exclusive there and inclusive here. */
export function legacyRrule(legacy: LegacyRepeat, start?: Date, zone?: string | null): Rrule | null {
	if (legacy.repeat === "none") return null;
	const rule: Rrule = { freq: "DAILY", interval: 1, count: null, untilMs: legacy.repeatUntil ? legacy.repeatUntil.getTime() - 1 : null, untilDay: null, byDay: [], byMonthDay: [], byMonth: [], bySetPos: [], wkst: 1 };
	if (legacy.repeat === "weekly") rule.freq = "WEEKLY";
	else if (legacy.repeat === "weekdays") rule.byDay = legacy.repeatDays.map((day) => ({ ordinal: 0, day }));
	else if (legacy.repeat === "monthly") {
		rule.freq = "MONTHLY";
		const day = legacy.repeatAnchorDay ?? (start ? zonedDateFields(start, normalizeTimeZone(zone)).getUTCDate() : null);
		if (day) rule.byMonthDay = [day];
		rule.clampMonthDay = true;
	}
	return rule;
}

function parseDays(value: string | undefined): number[] {
	try { const parsed: unknown = JSON.parse(value ?? "[]"); return Array.isArray(parsed) ? parsed.filter((day): day is number => Number.isInteger(day) && day >= 0 && day <= 6) : []; } catch { return []; }
}

function parseExcluded(value: string | undefined): Set<number> {
	try { const parsed: unknown = JSON.parse(value ?? "[]"); return new Set(Array.isArray(parsed) ? parsed.filter((item): item is number => Number.isSafeInteger(item)) : []); } catch { return new Set(); }
}

/**
 * Starts of the occurrences of one event row in [from, to), with exclusions applied. A weekday repeat is the daily rule
 * filtered to its days, like the legacy expanders. A "custom" row without a usable rule is a single occurrence.
 */
export function expandEventStarts(event: RecurringEvent, from: Date, to: Date, max = 500): Date[] {
	return expandEvent(event, from, to, max).starts;
}

/** expandEventStarts that also says whether the work budget ended the walk (`exhausted`: occurrences may be missing). */
export function expandEvent(event: RecurringEvent, from: Date, to: Date, max = 500): Walk {
	const zone = normalizeTimeZone(event.timeZone);
	let rule: Rrule | null = null;
	if (event.repeat === "custom") rule = event.rrule ? parseRrule(event.rrule, zone) : null;
	else if (event.repeat !== "none") rule = legacyRrule({ repeat: event.repeat as LegacyRepeat["repeat"], repeatDays: parseDays(event.repeatDays), repeatAnchorDay: event.repeatAnchorDay ?? null, repeatUntil: event.repeatUntil ?? null }, event.startsAt, zone);
	const excluded = parseExcluded(event.excludedOccurrences);
	const { starts, exhausted } = rule ? walk(rule, event.startsAt, zone, from, to, max + excluded.size) : { starts: event.startsAt >= from && event.startsAt < to ? [event.startsAt] : [], exhausted: false };
	return { starts: starts.filter((at) => !excluded.has(at.getTime())).slice(0, max), exhausted };
}

/** Starts of the occurrences that overlap [start, end): the row's duration is added to the lookback. */
export function expandEventOccurrences(event: RecurringEvent, start: Date, end: Date, max = 500): Date[] {
	const duration = event.endsAt.getTime() - event.startsAt.getTime();
	return expandEventStarts(event, new Date(start.getTime() - duration), end, max).filter((at) => at.getTime() + duration > start.getTime());
}

const ICS_UTC = (date: Date) => date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");

/**
 * The rule for "delete this and following" on a custom series: nothing from `cut` on. It never lengthens a series: one that
 * already ended before the cut, or whose UNTIL is earlier, comes back unchanged; otherwise UNTIL is `cut` minus one second
 * and COUNT is dropped. UNTIL is a DATE for an all-day event (the date in its zone) and a UTC date-time otherwise, the same
 * type as DTSTART, as RFC 5545 3.3.10 requires.
 */
export function limitRrule(value: string, cut: Date, dtstart: Date, zone: string | null | undefined, allDay: boolean): string {
	const timeZone = normalizeTimeZone(zone);
	const rule = parseRrule(value, timeZone);
	const until = new Date(cut.getTime() - 1000);
	if (rule) {
		const { last, exhausted } = lastStart(rule, dtstart, timeZone);
		// An ended series stays as it is. So does a COUNT series whose end could not be computed: rewriting COUNT into an UNTIL
		// at the cut could revive occurrences the COUNT had already ended.
		if (last && last < cut && (!exhausted || rule.count !== null)) return value;
		const existing = rule.untilMs ?? (rule.untilDay !== null ? dateFromZonedFields(new Date((rule.untilDay + 1) * DAY), timeZone).getTime() - 1 : null);
		if (existing !== null && existing <= until.getTime()) return value;
	}
	const parts = value.replace(/^RRULE:/i, "").split(";").filter((part) => !/^(UNTIL|COUNT)=/i.test(part.trim()));
	return [...parts, `UNTIL=${allDay ? zonedDateFields(until, timeZone).toISOString().slice(0, 10).replace(/-/g, "") : ICS_UTC(until)}`].join(";");
}

const MAX_LEGACY_CHECK = 400;

/**
 * The legacy columns that give exactly the same occurrences as `value`, or null when none do (the caller then stores
 * `rrule` and `repeat = "custom"`). A shape is only returned after both forms are expanded over 400 occurrences and
 * agree, so a clamped 31st or an unusual weekday set never passes as a plain repeat. COUNT becomes `repeatUntil` just
 * after the last occurrence, as inviteRepeat does.
 */
export function legacyRepeatFor(value: string, start: Date, zone?: string | null): LegacyRepeat | null {
	const timeZone = normalizeTimeZone(zone);
	const rule = parseRrule(value, timeZone);
	if (!rule || rule.interval !== 1 || rule.bySetPos.length || rule.byMonth.length) return null;
	const startFields = zonedDateFields(start, timeZone);
	const days = [...new Set(rule.byDay.map((item) => item.day))].sort((a, b) => a - b);
	let candidate: LegacyRepeat | null = null;
	const base = { repeatDays: [] as number[], repeatAnchorDay: null as number | null, repeatUntil: null as Date | null };
	if (rule.byDay.some((item) => item.ordinal)) return null;
	if (rule.freq === "DAILY" && !days.length && !rule.byMonthDay.length) candidate = { ...base, repeat: "daily" };
	else if (rule.freq === "WEEKLY" && !rule.byMonthDay.length) {
		if (!days.length || (days.length === 1 && days[0] === startFields.getUTCDay())) candidate = { ...base, repeat: "weekly" };
		else if (days.includes(startFields.getUTCDay())) candidate = { ...base, repeat: "weekdays", repeatDays: days };
	} else if (rule.freq === "MONTHLY" && !days.length && rule.byMonthDay.length <= 1 && (!rule.byMonthDay.length || rule.byMonthDay[0] === startFields.getUTCDate())) {
		candidate = { ...base, repeat: "monthly", repeatAnchorDay: rule.byMonthDay[0] ?? null };
	}
	if (!candidate) return null;
	const far = new Date(start.getTime() + 200 * 366 * DAY);
	const wanted = expandRrule(rule, start, timeZone, start, far, MAX_LEGACY_CHECK);
	// repeatUntil is exclusive. UNTIL gives it directly (the 400 compared instants may stop long before a far UNTIL); COUNT is
	// the instant after its last occurrence, which is only known when the compared instants reach it.
	if (rule.untilMs !== null) candidate.repeatUntil = new Date(rule.untilMs + 1);
	else if (rule.untilDay !== null) candidate.repeatUntil = dateFromZonedFields(new Date((rule.untilDay + 1) * DAY), timeZone);
	else if (rule.count !== null) {
		if (rule.count > MAX_LEGACY_CHECK) return null;
		candidate.repeatUntil = new Date(wanted[wanted.length - 1].getTime() + 1);
	}
	const legacy = legacyRrule(candidate, start, timeZone)!;
	const got = expandRrule(legacy, start, timeZone, start, far, MAX_LEGACY_CHECK);
	return got.length === wanted.length && got.every((at, index) => at.getTime() === wanted[index].getTime()) ? candidate : null;
}

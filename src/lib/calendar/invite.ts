import { dateFromZonedFields, normalizeTimeZone, zonedDateFields } from "../time/utils";
import { escapeIcsText, formatIcsUtc, ICS_ADDRESS, joinIcsLines } from "./ics";

export type ParsedInvite = {
	uid: string;
	method: string;
	title: string;
	description: string;
	location: string;
	startsAt: Date;
	endsAt: Date;
	allDay: boolean;
	organizer: string | null;
	rrule: string | null;
	/** IANA zone of DTSTART when it named one (Windows names are translated); null for UTC, floating and all-day times. */
	timeZone: string | null;
	/** Set when this VEVENT is about one occurrence of a recurring series. */
	recurrenceId: Date | null;
	/** SEQUENCE, the organizer's revision number of the invitation; 0 when absent. */
	sequence: number;
	/** EXDATE instants of a recurring series (at most the first 1000 values). */
	excludedDates: Date[];
	/** The zone floating, all-day and unresolvable-TZID times were read in (the `timeZone` option, else UTC). */
	recipientZone: string;
	/** True when any time in the event was read in `recipientZone` rather than from the file itself. */
	usedFallbackZone: boolean;
	/** ATTENDEE lines with their PARTSTAT; a REPLY carries the answering guest here. */
	attendees: { email: string; status: string }[];
};

export type ParseInviteOptions = {
	/** The recipient's IANA zone, used for floating times, unknown TZIDs and all-day dates. Defaults to UTC. */
	timeZone?: string | null;
};

export type InviteRepeat = {
	repeat: "none" | "daily" | "weekly" | "monthly" | "weekdays";
	repeatDays: number[];
	repeatAnchorDay: number | null;
	repeatUntil: Date | null;
};

const stripControls = (value: string) => value.replace(/[\u0000-\u001f\u007f]/g, "");

const WEEKDAY_CODES = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];
const DAY_MS = 86_400_000;
/** Limit on sender-controlled input that the inbound path parses automatically. */
const MAX_EXDATES = 1000;

/**
 * Windows time zone names (as Outlook and Exchange write them in TZID) to IANA names, following the
 * CLDR windowsZones table for the "001" territory.
 */
export const WINDOWS_TIME_ZONES: Record<string, string> = {
	"Dateline Standard Time": "Etc/GMT+12",
	"UTC-11": "Etc/GMT+11",
	"Hawaiian Standard Time": "Pacific/Honolulu",
	"Alaskan Standard Time": "America/Anchorage",
	"Pacific Standard Time": "America/Los_Angeles",
	"Pacific Standard Time (Mexico)": "America/Tijuana",
	"US Mountain Standard Time": "America/Phoenix",
	"Mountain Standard Time": "America/Denver",
	"Mountain Standard Time (Mexico)": "America/Mazatlan",
	"Central America Standard Time": "America/Guatemala",
	"Central Standard Time": "America/Chicago",
	"Central Standard Time (Mexico)": "America/Mexico_City",
	"Canada Central Standard Time": "America/Regina",
	"SA Pacific Standard Time": "America/Bogota",
	"Eastern Standard Time": "America/New_York",
	"Eastern Standard Time (Mexico)": "America/Cancun",
	"US Eastern Standard Time": "America/Indiana/Indianapolis",
	"Atlantic Standard Time": "America/Halifax",
	"SA Western Standard Time": "America/La_Paz",
	"Pacific SA Standard Time": "America/Santiago",
	"Newfoundland Standard Time": "America/St_Johns",
	"E. South America Standard Time": "America/Sao_Paulo",
	"Argentina Standard Time": "America/Argentina/Buenos_Aires",
	"UTC": "UTC",
	"Coordinated Universal Time": "UTC",
	"GMT Standard Time": "Europe/London",
	"Greenwich Standard Time": "Atlantic/Reykjavik",
	"W. Europe Standard Time": "Europe/Berlin",
	"Central Europe Standard Time": "Europe/Budapest",
	"Central European Standard Time": "Europe/Warsaw",
	"Romance Standard Time": "Europe/Paris",
	"W. Central Africa Standard Time": "Africa/Lagos",
	"GTB Standard Time": "Europe/Bucharest",
	"E. Europe Standard Time": "Europe/Chisinau",
	"FLE Standard Time": "Europe/Kiev",
	"Egypt Standard Time": "Africa/Cairo",
	"South Africa Standard Time": "Africa/Johannesburg",
	"Israel Standard Time": "Asia/Jerusalem",
	"Turkey Standard Time": "Europe/Istanbul",
	"Russian Standard Time": "Europe/Moscow",
	"Arab Standard Time": "Asia/Riyadh",
	"Arabian Standard Time": "Asia/Dubai",
	"E. Africa Standard Time": "Africa/Nairobi",
	"Iran Standard Time": "Asia/Tehran",
	"Pakistan Standard Time": "Asia/Karachi",
	"India Standard Time": "Asia/Kolkata",
	"Nepal Standard Time": "Asia/Kathmandu",
	"Bangladesh Standard Time": "Asia/Dhaka",
	"SE Asia Standard Time": "Asia/Bangkok",
	"China Standard Time": "Asia/Shanghai",
	"Singapore Standard Time": "Asia/Singapore",
	"Taipei Standard Time": "Asia/Taipei",
	"W. Australia Standard Time": "Australia/Perth",
	"Tokyo Standard Time": "Asia/Tokyo",
	"Korea Standard Time": "Asia/Seoul",
	"Cen. Australia Standard Time": "Australia/Adelaide",
	"AUS Central Standard Time": "Australia/Darwin",
	"E. Australia Standard Time": "Australia/Brisbane",
	"AUS Eastern Standard Time": "Australia/Sydney",
	"Tasmania Standard Time": "Australia/Hobart",
	"New Zealand Standard Time": "Pacific/Auckland",
	"Fiji Standard Time": "Pacific/Fiji",
};

/** The IANA zone for a TZID value, or null when neither the Windows table nor Intl knows it. */
export function resolveIcsTimeZone(tzid: string | undefined): string | null {
	const name = tzid?.trim();
	if (!name) return null;
	// Building an Intl formatter is costly and one file can repeat the same TZID on every EXDATE value.
	const cached = resolvedZones.get(name);
	if (cached !== undefined) return cached;
	const candidate = WINDOWS_TIME_ZONES[name] ?? name;
	let resolved: string | null = null;
	try {
		new Intl.DateTimeFormat("en-US", { timeZone: candidate });
		resolved = candidate;
	} catch { /* unknown zone */ }
	if (resolvedZones.size >= 256) resolvedZones.clear();
	resolvedZones.set(name, resolved);
	return resolved;
}

const resolvedZones = new Map<string, string | null>();

function unfold(text: string): string[] {
	return text.replace(/\r?\n[ \t]/g, "").split(/\r?\n/);
}

function unescapeText(value: string): string {
	return value.replace(/\\n/gi, "\n").replace(/\\([,;\\])/g, "$1");
}

type Property = { name: string; params: Record<string, string>; value: string };

/** Splits on `separator` wherever it is outside a double-quoted parameter value. */
function splitOutsideQuotes(text: string, separator: string): string[] {
	const parts: string[] = [];
	let quoted = false;
	let start = 0;
	for (let index = 0; index < text.length; index++) {
		const char = text[index];
		if (char === "\"") quoted = !quoted;
		else if (char === separator && !quoted) {
			parts.push(text.slice(start, index));
			start = index + 1;
		}
	}
	parts.push(text.slice(start));
	return parts;
}

function parseProperty(line: string): Property | null {
	// The value starts at the first colon outside quotes, so a parameter such as CN="Doe: J" stays a parameter.
	let quoted = false;
	let colon = -1;
	for (let index = 0; index < line.length; index++) {
		const char = line[index];
		if (char === "\"") quoted = !quoted;
		else if (char === ":" && !quoted) { colon = index; break; }
	}
	if (colon < 1) return null;
	const [name, ...rawParams] = splitOutsideQuotes(line.slice(0, colon), ";");
	const params: Record<string, string> = {};
	for (const raw of rawParams) {
		const eq = raw.indexOf("=");
		if (eq > 0) params[raw.slice(0, eq).trim().toUpperCase()] = raw.slice(eq + 1).replace(/^"|"$/g, "");
	}
	return { name: name.trim().toUpperCase(), params, value: line.slice(colon + 1) };
}

/** `fallback` is true when the value was read in the recipient's zone (all-day, floating or an unresolvable TZID). */
type ParsedDate = { date: Date; allDay: boolean; timeZone: string | null; zone: string; fallback: boolean };

const isFiniteDate = (value: Date | null | undefined): value is Date => !!value && Number.isFinite(value.getTime());

/**
 * The instant of a wall-clock time in `zone`, identical to dateFromZonedFields (which the calendar uses to compute
 * occurrence starts, so excluded instants must match it exactly) but with two Intl calls instead of four when no
 * offset change lies within a day either side, which is nearly always. Near a change it defers to dateFromZonedFields.
 */
function wallToInstant(wall: Date, zone: string): Date {
	const before = new Date(wall.getTime() - DAY_MS);
	const after = new Date(wall.getTime() + DAY_MS);
	const offsetBefore = zonedDateFields(before, zone).getTime() - before.getTime();
	const offsetAfter = zonedDateFields(after, zone).getTime() - after.getTime();
	return offsetBefore === offsetAfter ? new Date(wall.getTime() - offsetBefore) : dateFromZonedFields(wall, zone);
}

/**
 * Reads a DATE or DATE-TIME value. UTC values (trailing Z) are exact; a TZID the Windows table or Intl knows is
 * converted from that zone; floating times, unknown TZIDs and all-day dates are wall-clock times in `localZone`.
 * `zone` is the zone the wall clock was read in, used to step whole days. Impossible dates (month 13, February 30,
 * hour 25) are null rather than rolled over into another date.
 */
export function parseIcsDate(property: Property, localZone = "UTC"): ParsedDate | null {
	const match = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z?))?$/.exec(property.value.trim());
	if (!match) return null;
	const [, y, mo, d, h, mi, s, z] = match;
	const fields = [Number(y), Number(mo) - 1, Number(d), Number(h ?? 0), Number(mi ?? 0), Number(s ?? 0)] as const;
	const wall = new Date(Date.UTC(...fields));
	if (!isFiniteDate(wall)) return null;
	const actual = [wall.getUTCFullYear(), wall.getUTCMonth(), wall.getUTCDate(), wall.getUTCHours(), wall.getUTCMinutes(), wall.getUTCSeconds()];
	if (actual.some((value, index) => value !== fields[index])) return null;
	let result: ParsedDate;
	if (h === undefined) result = { date: wallToInstant(wall, localZone), allDay: true, timeZone: null, zone: localZone, fallback: true };
	else if (z) result = { date: wall, allDay: false, timeZone: null, zone: "UTC", fallback: false };
	else {
		const zone = resolveIcsTimeZone(property.params.TZID);
		// Floating time, or a zone nobody can resolve: the clock time the sender meant, read in the recipient's zone.
		result = zone
			? { date: wallToInstant(wall, zone), allDay: false, timeZone: zone, zone, fallback: false }
			: { date: wallToInstant(wall, localZone), allDay: false, timeZone: null, zone: localZone, fallback: true };
	}
	return isFiniteDate(result.date) ? result : null;
}

/** Adds whole days on the wall clock of `zone`, so a day stays a day across daylight saving changes. */
function addZonedDays(value: Date, days: number, zone: string): Date {
	if (!days) return value;
	const fields = zonedDateFields(value, zone);
	fields.setUTCDate(fields.getUTCDate() + days);
	return dateFromZonedFields(fields, zone);
}

/** Longest DURATION accepted; anything longer is treated as absent. */
const MAX_DURATION_DAYS = 366;

/** RFC 5545 DURATION: weeks, days, hours, minutes and seconds. Negative, malformed or over-long (366 days) durations are null. */
export function parseIcsDuration(value: string | undefined): { days: number; ms: number } | null {
	const match = /^\+?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/i.exec(value?.trim() ?? "");
	if (!match || value?.trim().toUpperCase().endsWith("T")) return null;
	const [, weeks, days, hours, minutes, seconds] = match;
	const result = { days: Number(weeks ?? 0) * 7 + Number(days ?? 0), ms: (Number(hours ?? 0) * 3600 + Number(minutes ?? 0) * 60 + Number(seconds ?? 0)) * 1000 };
	if (!Number.isFinite(result.days) || !Number.isFinite(result.ms) || result.days * DAY_MS + result.ms > MAX_DURATION_DAYS * DAY_MS) return null;
	return result.days || result.ms ? result : null;
}

/** The properties of each VEVENT, ignoring those of components nested in it (VALARM and the like). */
function readEvents(lines: string[]): { method: string; events: Property[][] } {
	let method = "PUBLISH";
	const events: Property[][] = [];
	let current: Property[] | null = null;
	let nested = 0;
	for (const line of lines) {
		const property = parseProperty(line);
		if (!property) continue;
		if (property.name === "BEGIN") {
			const component = property.value.trim().toUpperCase();
			if (current) nested++;
			else if (component === "VEVENT") { current = []; nested = 0; }
			continue;
		}
		if (property.name === "END") {
			if (!current) continue;
			if (nested > 0) { nested--; continue; }
			events.push(current);
			current = null;
			continue;
		}
		if (current) {
			if (nested === 0) current.push(property);
		} else if (property.name === "METHOD") method = property.value.trim().toUpperCase();
	}
	return { method, events };
}

/**
 * Reads the invitation in an iCalendar file, or null when there is none or it cannot be read. The file is
 * sender-controlled and parsed automatically on delivery and whenever the message is opened, so this never throws.
 */
export function parseInvite(text: string, options: ParseInviteOptions = {}): ParsedInvite | null {
	try {
		return readInvite(text, options);
	} catch {
		return null;
	}
}

function readInvite(text: string, options: ParseInviteOptions): ParsedInvite | null {
	const localZone = normalizeTimeZone(options.timeZone);
	const { method, events } = readEvents(unfold(text));
	if (!events.length) return null;
	// A file can carry the series and its changed occurrences; the series (no RECURRENCE-ID) describes the invitation.
	const event = events.find((properties) => !properties.some((property) => property.name === "RECURRENCE-ID")) ?? events[0];
	const find = (name: string) => event.find((property) => property.name === name);
	const uid = find("UID")?.value.trim();
	const startProperty = find("DTSTART");
	const start = startProperty ? parseIcsDate(startProperty, localZone) : null;
	if (!uid || !start) return null;
	const endProperty = find("DTEND");
	const end = endProperty ? parseIcsDate(endProperty, localZone) : null;
	const duration = parseIcsDuration(find("DURATION")?.value);
	const startsAt = start.date;
	let endsAt: Date;
	if (end) endsAt = end.date;
	else if (duration) endsAt = new Date(addZonedDays(startsAt, duration.days, start.zone).getTime() + duration.ms);
	else endsAt = start.allDay ? addZonedDays(startsAt, 1, start.zone) : new Date(startsAt.getTime() + 3_600_000);
	if (endsAt <= startsAt) endsAt = start.allDay ? addZonedDays(startsAt, 1, start.zone) : new Date(startsAt.getTime() + 3_600_000);
	if (!isFiniteDate(startsAt) || !isFiniteDate(endsAt)) return null;
	const recurrenceProperty = find("RECURRENCE-ID");
	const recurrence = recurrenceProperty ? parseIcsDate(recurrenceProperty, localZone) : null;
	// An occurrence id that cannot be read must not turn a one-occurrence cancel into a cancel of the whole series.
	if (recurrenceProperty && !recurrence) return null;
	const sequence = Number.parseInt(find("SEQUENCE")?.value.trim() ?? "", 10);
	// Cap the raw values before parsing any, so a file with thousands of EXDATEs costs at most MAX_EXDATES parses.
	const rawExdates: { property: Property; value: string }[] = [];
	for (const property of event) {
		if (property.name !== "EXDATE") continue;
		for (const value of property.value.split(",", MAX_EXDATES - rawExdates.length)) rawExdates.push({ property, value });
		if (rawExdates.length >= MAX_EXDATES) break;
	}
	const exdates = rawExdates.map(({ property, value }) => parseIcsDate({ ...property, value }, localZone)).filter((date): date is ParsedDate => !!date);
	const usedFallbackZone = start.fallback || !!end?.fallback || !!recurrence?.fallback || exdates.some((date) => date.fallback);
	const organizer = find("ORGANIZER")?.value.trim().replace(/^mailto:/i, "") || null;
	return {
		uid, method, startsAt, endsAt,
		recipientZone: localZone,
		usedFallbackZone,
		title: unescapeText(find("SUMMARY")?.value ?? "").trim() || "(no title)",
		description: unescapeText(find("DESCRIPTION")?.value ?? "").trim(),
		location: unescapeText(find("LOCATION")?.value ?? "").trim(),
		allDay: start.allDay,
		organizer,
		rrule: find("RRULE")?.value.trim() ?? null,
		timeZone: start.timeZone,
		recurrenceId: recurrence?.date ?? null,
		sequence: Number.isSafeInteger(sequence) && sequence >= 0 ? sequence : 0,
		excludedDates: exdates.map((date) => date.date),
		attendees: event.filter((property) => property.name === "ATTENDEE").map((property) => ({ email: property.value.trim().replace(/^mailto:/i, "").toLowerCase(), status: (property.params.PARTSTAT ?? "NEEDS-ACTION").toUpperCase() })),
	};
}

/**
 * Mailflare stores repeatUntil as an exclusive bound (`occurrence >= repeatUntil` stops the series) in whole seconds,
 * while RFC 5545 UNTIL and the last COUNT occurrence are inclusive. One second past the last start keeps it.
 */
const INCLUSIVE_PAD_MS = 1000;

/** Start of the occurrence at `index` (0 is the first), stepping the wall clock of `zone` like the calendar does. */
function nthOccurrence(start: Date, repeat: InviteRepeat, index: number, zone: string): Date {
	if (index === 0) return start;
	const fields = zonedDateFields(start, zone);
	if (repeat.repeat === "monthly") {
		const day = repeat.repeatAnchorDay ?? fields.getUTCDate();
		fields.setUTCDate(1);
		fields.setUTCMonth(fields.getUTCMonth() + index);
		fields.setUTCDate(Math.min(day, new Date(Date.UTC(fields.getUTCFullYear(), fields.getUTCMonth() + 1, 0)).getUTCDate()));
	} else fields.setUTCDate(fields.getUTCDate() + index * (repeat.repeat === "weekly" ? 7 : 1));
	return dateFromZonedFields(fields, zone);
}

/** A COUNT whose last occurrence is further out than this is not stored as a bounded series. */
const MAX_SERIES_SPAN_DAYS = 200 * 366;

/**
 * Start of the last of `count` occurrences, matching how the calendar expands each repeat kind, or null when it lies
 * more than about 200 years out or cannot be computed. Constant work for any count.
 */
function lastOccurrenceStart(start: Date, repeat: InviteRepeat, count: number, zone: string): Date | null {
	const daily = { ...repeat, repeat: "daily" as const };
	let last: Date | null;
	if (repeat.repeat === "weekdays") {
		// The calendar walks day by day and keeps the days whose weekday is listed. Every 7 consecutive days hold each
		// listed weekday once, so occurrence j is offset[j % k] days into week floor(j / k).
		const offsets: number[] = [];
		for (let day = 0; day < 7; day++) {
			if (repeat.repeatDays.includes(zonedDateFields(nthOccurrence(start, daily, day, zone), zone).getUTCDay())) offsets.push(day);
		}
		if (!offsets.length) return null;
		const index = count - 1;
		const days = Math.floor(index / offsets.length) * 7 + offsets[index % offsets.length];
		if (days > MAX_SERIES_SPAN_DAYS) return null;
		last = nthOccurrence(start, daily, days, zone);
	} else {
		const spanDays = (count - 1) * (repeat.repeat === "weekly" ? 7 : repeat.repeat === "monthly" ? 31 : 1);
		if (spanDays > MAX_SERIES_SPAN_DAYS) return null;
		last = nthOccurrence(start, repeat, count - 1, zone);
	}
	return isFiniteDate(last) && last.getTime() - start.getTime() <= MAX_SERIES_SPAN_DAYS * DAY_MS ? last : null;
}

/**
 * Maps the RRULE shapes Mailflare can store; anything else becomes a one-off event on the first date.
 * `startsAt` (and the zone its clock time is in) is needed to turn COUNT into an end date.
 */
export function inviteRepeat(rrule: string | null, startsAt?: Date, timeZone?: string | null): InviteRepeat {
	const none: InviteRepeat = { repeat: "none", repeatDays: [], repeatAnchorDay: null, repeatUntil: null };
	if (!rrule) return none;
	const zone = normalizeTimeZone(timeZone);
	const rule: Record<string, string> = Object.fromEntries(rrule.split(";").map((part) => {
		const eq = part.indexOf("=");
		return [part.slice(0, eq).trim().toUpperCase(), part.slice(eq + 1).trim().toUpperCase()];
	}));
	if (rule.INTERVAL && rule.INTERVAL !== "1") return none;
	let repeat: InviteRepeat;
	const byDays = [...new Set((rule.BYDAY ?? "").split(",").map((code) => WEEKDAY_CODES.indexOf(code.replace(/^[+-]?\d+/, ""))).filter((day) => day >= 0))].sort((a, b) => a - b);
	// DAILY with BYDAY (Outlook's "every weekday") keeps only the listed days, which is Mailflare's weekdays repeat.
	if (rule.FREQ === "DAILY") repeat = byDays.length ? { ...none, repeat: "weekdays", repeatDays: byDays } : { ...none, repeat: "daily" };
	else if (rule.FREQ === "WEEKLY") {
		repeat = byDays.length > 1 ? { ...none, repeat: "weekdays", repeatDays: byDays } : { ...none, repeat: "weekly" };
	} else if (rule.FREQ === "MONTHLY" && !rule.BYDAY) {
		const day = Number(rule.BYMONTHDAY);
		repeat = { ...none, repeat: "monthly", repeatAnchorDay: Number.isInteger(day) && day >= 1 && day <= 31 ? day : null };
	} else return none;
	if (rule.UNTIL) {
		const until = parseIcsDate({ name: "UNTIL", params: {}, value: rule.UNTIL }, zone);
		// A date-only UNTIL includes that whole day.
		if (until) repeat.repeatUntil = until.allDay ? addZonedDays(until.date, 1, zone) : new Date(until.date.getTime() + INCLUSIVE_PAD_MS);
	} else if (rule.COUNT) {
		// A COUNT that cannot be turned into a safe end date becomes a single event, never an endless series.
		const count = Number(rule.COUNT);
		if (!startsAt || !Number.isSafeInteger(count) || count < 1) return none;
		const last = lastOccurrenceStart(startsAt, repeat, count, zone);
		if (!last) return none;
		repeat.repeatUntil = new Date(last.getTime() + INCLUSIVE_PAD_MS);
	}
	return repeat;
}

export type InviteResponse = "accepted" | "tentative" | "declined";

export function buildReplyIcs(invite: ParsedInvite, attendee: string, response: InviteResponse): string {
	const status = { accepted: "ACCEPTED", tentative: "TENTATIVE", declined: "DECLINED" }[response];
	// All-day values were read as midnights in the recipient's zone; write them back as the DATE the sender used.
	const dateValue = (name: string, value: Date) => invite.allDay
		? `${name};VALUE=DATE:${zonedDateFields(value, normalizeTimeZone(invite.recipientZone)).toISOString().slice(0, 10).replace(/-/g, "")}`
		: `${name}:${formatIcsUtc(value)}`;
	const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Mailflare//Calendar//EN", "METHOD:REPLY", "BEGIN:VEVENT", `UID:${stripControls(invite.uid)}`, `DTSTAMP:${formatIcsUtc(new Date())}`,
		dateValue("DTSTART", invite.startsAt),
		...(invite.recurrenceId ? [dateValue("RECURRENCE-ID", invite.recurrenceId)] : []),
		`SEQUENCE:${invite.sequence}`,
		`SUMMARY:${escapeIcsText(invite.title)}`,
		...(invite.organizer && ICS_ADDRESS.test(invite.organizer) ? [`ORGANIZER:mailto:${invite.organizer}`] : []),
		`ATTENDEE;PARTSTAT=${status}:mailto:${ICS_ADDRESS.test(attendee) ? attendee : "unknown@invalid"}`, "END:VEVENT", "END:VCALENDAR"];
	return joinIcsLines(lines);
}

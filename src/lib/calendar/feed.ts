import { escapeIcsText, foldIcsLine, formatIcsUtc, isIcsAddress, joinIcsLines } from "./ics";
import { parseCalendarRepeatDays, parseExcludedOccurrences } from "./recurrence";
import { isSeriesOccurrence } from "./tool-occurrences";
import { vtimezoneLines } from "./vtimezone";

export { escapeIcsText, foldIcsLine };

/** One edited occurrence (RECURRENCE-ID): replaces the rule occurrence at `occurrenceMs`, or adds an extra one when no rule occurrence has that start. Null text fields inherit the series value. */
export type FeedOccurrenceOverride = { occurrenceMs: number; startsAt: Date; endsAt: Date; title?: string | null; description?: string | null; location?: string | null };

export type FeedEvent = {
	id: string;
	title: string;
	description: string;
	location: string;
	startsAt: Date;
	endsAt: Date;
	repeat: "none" | "daily" | "weekly" | "monthly" | "weekdays" | "yearly";
	repeatDays: string;
	repeatAnchorDay: number | null;
	repeatUntil: Date | null;
	/** Step between recurrences: every N days/weeks/months/years. */
	repeatInterval?: number | null;
	/** Weekday (0-6) and week (1-5, -1 = last) of an nth-weekday monthly repeat. */
	repeatWeekday?: number | null;
	repeatWeek?: number | null;
	excludedOccurrences: string;
	timeZone: string | null;
	attendees: string;
	/** JSON map of guest address to accepted, tentative or declined; a download writes it as ATTENDEE PARTSTAT. */
	attendeeResponses?: string | null;
	/** Minutes before an occurrence's start to remind; a download writes it as a VALARM. */
	reminderMinutes?: number | null;
	updatedAt?: Date | null;
	responseStatus?: string | null;
};

const BYDAY = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];

const utc = formatIcsUtc;

function local(value: Date, timeZone: string): string {
	const parts = new Intl.DateTimeFormat("en-CA", { timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(value);
	const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "00";
	return `${get("year")}${get("month")}${get("day")}T${get("hour")}${get("minute")}${get("second")}`;
}

function validTimeZone(value: string | null): string | null {
	if (!value) return null;
	try { new Intl.DateTimeFormat("en", { timeZone: value }); return value; } catch { return null; }
}

function dateProperty(name: string, value: Date, timeZone: string | null): string {
	return timeZone ? `${name};TZID=${timeZone}:${local(value, timeZone)}` : `${name}:${utc(value)}`;
}

// The app moves a monthly event anchored on the 29th-31st to the last day of shorter months, while a plain
// BYMONTHDAY=31 skips them (RFC 5545 drops invalid dates), so those anchors list 28..anchor and keep the last.
function monthDayRule(day: number): string {
	if (day < 29) return `BYMONTHDAY=${day}`;
	return `BYMONTHDAY=${Array.from({ length: day - 27 }, (_, index) => 28 + index).join(",")};BYSETPOS=-1`;
}

function recurrenceRule(event: FeedEvent, download: boolean): string | null {
	if (event.repeat === "none") return null;
	const parts: string[] = [];
	if (event.repeat === "daily") parts.push("FREQ=DAILY");
	else if (event.repeat === "weekly") parts.push("FREQ=WEEKLY");
	else if (event.repeat === "yearly") {
		parts.push("FREQ=YEARLY");
		// The app clamps a Feb-29 yearly to Feb 28 in common years; the download says so explicitly,
		// since a bare YEARLY recurs only on leap days and a plain BYMONTHDAY=29 rolls to March 1.
		if (download) {
			const zone = validTimeZone(event.timeZone);
			if ((zone ? local(event.startsAt, zone) : utc(event.startsAt)).slice(4, 8) === "0229") parts.push("BYMONTH=2", monthDayRule(29));
		}
	} else if (event.repeat === "monthly") {
		parts.push("FREQ=MONTHLY");
		if (event.repeatWeekday != null && event.repeatWeek != null) {
			// The app's fifth-weekday repeat clamps to the last matching day of shorter months — BYDAY=-1 is that rule.
			const week = download && event.repeatWeek === 5 ? -1 : event.repeatWeek;
			parts.push(`BYDAY=${week}${BYDAY[event.repeatWeekday]}`);
		}
		else {
			const zone = validTimeZone(event.timeZone);
			const day = event.repeatAnchorDay || Number((zone ? local(event.startsAt, zone) : utc(event.startsAt)).slice(6, 8));
			parts.push(monthDayRule(day));
		}
	} else {
		const days = parseCalendarRepeatDays(event.repeatDays);
		if (!days.length) return null;
		parts.push("FREQ=WEEKLY", `BYDAY=${days.map((day) => BYDAY[day]).join(",")}`);
	}
	const interval = event.repeat === "weekdays" ? 1 : Number.isInteger(event.repeatInterval) ? (event.repeatInterval as number) : 1;
	// A listed-days repeat steps day by day, so its interval is always 1 and never written.
	if (interval > 1) parts.push(`INTERVAL=${interval}`);
	// repeatUntil is an exclusive bound in the app; RFC 5545 UNTIL is inclusive, so stop one second earlier.
	if (event.repeatUntil) parts.push(`UNTIL=${utc(new Date(event.repeatUntil.getTime() - 1000))}`);
	return `RRULE:${parts.join(";")}`;
}

/** ATTENDEE lines for a download: every listed guest, with the RSVP state the invite replies recorded. */
function attendeeLines(event: FeedEvent): string[] {
	let guests: unknown;
	try { guests = JSON.parse(event.attendees || "[]"); } catch { return []; }
	if (!Array.isArray(guests)) return [];
	let responses: Record<string, string> = {};
	try {
		const parsed: unknown = JSON.parse(event.attendeeResponses || "{}");
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) responses = parsed as Record<string, string>;
	} catch { /* A bad map leaves every guest at the RFC default. */ }
	return guests
		.filter((guest): guest is string => typeof guest === "string")
		.map((guest) => guest.trim())
		.filter((guest) => isIcsAddress(guest))
		.map((guest) => {
			const status = responses[guest.toLowerCase()];
			const partstat = status === "accepted" || status === "tentative" || status === "declined" ? status.toUpperCase() : "NEEDS-ACTION";
			return `ATTENDEE;PARTSTAT=${partstat}:mailto:${guest}`;
		});
}

/**
 * Writes the events as one VCALENDAR. `download` is a file the owner saves: it carries the guests a
 * polled feed hides, their RSVP states, the reminder, extra occurrences as RDATE and a VTIMEZONE for
 * every TZID it cites, and drops the subscription refresh hints.
 */
export function buildCalendarFeed(events: FeedEvent[], options: { name: string; now?: Date; download?: boolean }, overrides?: Map<string, FeedOccurrenceOverride[]>): string {
	const now = options.now ?? new Date();
	const stamp = utc(now);
	const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Mailflare//Calendar//EN", "CALSCALE:GREGORIAN"];
	// A feed is published, so METHOD:PUBLISH fits it. A download is a neutral snapshot and stays
	// METHOD-free: PUBLISH requires ORGANIZER wherever ATTENDEE lines appear (RFC 5546 3.2.1).
	if (!options.download) lines.push("METHOD:PUBLISH");
	lines.push(`X-WR-CALNAME:${escapeIcsText(options.name)}`);
	if (!options.download) lines.push("REFRESH-INTERVAL;VALUE=DURATION:PT1H", "X-PUBLISHED-TTL:PT1H");
	const eventLines: string[] = [];
	// Zone -> the instants events cite it for; each VTIMEZONE must cover them so a parser resolves every TZID.
	const zones = new Map<string, { earliest: number; latest: number }>();
	const noteInstant = (zone: string | null, ms: number) => {
		if (!zone) return;
		const span = zones.get(zone);
		if (span) { span.earliest = Math.min(span.earliest, ms); span.latest = Math.max(span.latest, ms); } else zones.set(zone, { earliest: ms, latest: ms });
	};
	for (const event of events) {
		const rule = recurrenceRule(event, options.download === true);
		// Recurring events keep their local clock time across daylight saving changes only when they carry a zone.
		const zone = rule ? validTimeZone(event.timeZone) : null;
		const excluded = new Set(parseExcludedOccurrences(event.excludedOccurrences));
		const masterMs = event.endsAt.getTime() - event.startsAt.getTime();
		// An override at a start the rule itself yields is an exception (RECURRENCE-ID); anywhere else
		// it is an extra occurrence the download declares as RDATE on the master. A feed has no extras.
		const extras: FeedOccurrenceOverride[] = [];
		const exceptions: FeedOccurrenceOverride[] = [];
		for (const override of overrides?.get(event.id) ?? []) {
			if (excluded.has(override.occurrenceMs)) continue;
			if (options.download && !isSeriesOccurrence(event, override.occurrenceMs)) extras.push(override); else exceptions.push(override);
		}
		noteInstant(zone, event.startsAt.getTime());
		eventLines.push("BEGIN:VEVENT", `UID:${event.id}@mailflare`, `DTSTAMP:${stamp}`,
			dateProperty("DTSTART", event.startsAt, zone), dateProperty("DTEND", event.endsAt, zone),
			`SUMMARY:${escapeIcsText(event.title)}`);
		if (event.description) eventLines.push(`DESCRIPTION:${escapeIcsText(event.description)}`);
		if (event.location) eventLines.push(`LOCATION:${escapeIcsText(event.location)}`);
		if (rule) {
			eventLines.push(rule);
			for (const ms of excluded) { noteInstant(zone, ms); eventLines.push(dateProperty("EXDATE", new Date(ms), zone)); }
		}
		for (const extra of extras) { noteInstant(zone, extra.occurrenceMs); eventLines.push(dateProperty("RDATE", new Date(extra.occurrenceMs), zone)); }
		if (event.responseStatus === "tentative") eventLines.push("STATUS:TENTATIVE");
		if (event.updatedAt) eventLines.push(`LAST-MODIFIED:${utc(event.updatedAt)}`);
		if (options.download) {
			for (const attendee of attendeeLines(event)) eventLines.push(attendee);
			// -PTnM is always a valid DURATION, so a large reminder stays in minutes.
			if (Number.isInteger(event.reminderMinutes) && (event.reminderMinutes as number) >= 0) eventLines.push("BEGIN:VALARM", "ACTION:DISPLAY", `DESCRIPTION:${escapeIcsText(event.title)}`, `TRIGGER:-PT${event.reminderMinutes}M`, "END:VALARM");
		}
		eventLines.push("END:VEVENT");
		// An extra whose start, length and text all match its RDATE needs no detached VEVENT; exceptions always do.
		const detached = [...exceptions, ...extras.filter((extra) => extra.startsAt.getTime() !== extra.occurrenceMs || extra.endsAt.getTime() - extra.startsAt.getTime() !== masterMs
			|| extra.title != null || extra.description != null || extra.location != null)];
		for (const override of detached) {
			noteInstant(zone, override.startsAt.getTime());
			eventLines.push("BEGIN:VEVENT", `UID:${event.id}@mailflare`, `DTSTAMP:${stamp}`,
				// The same TZID form as the master's DTSTART, so the RECURRENCE-ID pairs with its rule or RDATE occurrence.
				dateProperty("RECURRENCE-ID", new Date(override.occurrenceMs), zone),
				dateProperty("DTSTART", override.startsAt, zone), dateProperty("DTEND", override.endsAt, zone),
				`SUMMARY:${escapeIcsText(options.download ? (override.title ?? event.title) : event.title)}`);
			// A download restates the effective text: importers treat the exception as a full replacement.
			if (options.download) {
				const description = override.description ?? event.description;
				const location = override.location ?? event.location;
				if (description) eventLines.push(`DESCRIPTION:${escapeIcsText(description)}`);
				if (location) eventLines.push(`LOCATION:${escapeIcsText(location)}`);
			}
			eventLines.push("END:VEVENT");
		}
	}
	if (options.download) {
		for (const zone of [...zones.keys()].sort()) {
			const span = zones.get(zone) as { earliest: number; latest: number };
			// Padding keeps instants near the edges under the right observance, and ~15 years ahead lets
			// an open-ended series expand; an irregular zone's one-offs stop there and hold the last offset.
			lines.push(...vtimezoneLines(zone, span.earliest - 400 * 86_400_000, Math.max(now.getTime() + 15 * 365 * 86_400_000, span.latest + 400 * 86_400_000)));
		}
	}
	lines.push(...eventLines, "END:VCALENDAR");
	return joinIcsLines(lines);
}

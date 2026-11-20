import { escapeIcsText, foldIcsLine, formatIcsUtc, joinIcsLines } from "./ics";
import { parseCalendarRepeatDays, parseExcludedOccurrences } from "./recurrence";

export { escapeIcsText, foldIcsLine };

/** One edited occurrence (RECURRENCE-ID): replaces the rule occurrence at `occurrenceMs`, or adds an extra one when no rule occurrence has that start. */
export type FeedOccurrenceOverride = { occurrenceMs: number; startsAt: Date; endsAt: Date };

export type FeedEvent = {
	id: string;
	title: string;
	description: string;
	location: string;
	startsAt: Date;
	endsAt: Date;
	repeat: "none" | "daily" | "weekly" | "monthly" | "weekdays" | "yearly" | "custom";
	rrule?: string | null;
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
	updatedAt?: Date | null;
	responseStatus?: string | null;
	/** A DATE value (no time of day) in `timeZone`; the stored instants are midnight to midnight. */
	allDay?: boolean;
	/** Minutes before the start for a reminder; null or absent for none. Written as a VALARM only when `buildVevent` is asked to. */
	reminderMinutes?: number | null;
};

const BYDAY = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];

const utc = formatIcsUtc;

function local(value: Date, timeZone: string): string {
	const parts = new Intl.DateTimeFormat("en-CA", { timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(value);
	const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "00";
	return `${get("year")}${get("month")}${get("day")}T${get("hour")}${get("minute")}${get("second")}`;
}

export function validTimeZone(value: string | null | undefined): string | null {
	if (!value) return null;
	try { new Intl.DateTimeFormat("en", { timeZone: value }); return value; } catch { return null; }
}

function dateProperty(name: string, value: Date, timeZone: string | null, allDay = false): string {
	if (allDay) return `${name};VALUE=DATE:${local(value, timeZone ?? "UTC").slice(0, 8)}`;
	return timeZone ? `${name};TZID=${timeZone}:${local(value, timeZone)}` : `${name}:${utc(value)}`;
}

// The app moves a monthly event anchored on the 29th-31st to the last day of shorter months, while a plain
// BYMONTHDAY=31 skips them (RFC 5545 drops invalid dates), so those anchors list 28..anchor and keep the last.
function monthDayRule(day: number): string {
	if (day < 29) return `BYMONTHDAY=${day}`;
	return `BYMONTHDAY=${Array.from({ length: day - 27 }, (_, index) => 28 + index).join(",")};BYSETPOS=-1`;
}

function recurrenceRule(event: FeedEvent, zone: string | null): string | null {
	if (event.repeat === "none") return null;
	if (event.repeat === "custom") return event.rrule ? `RRULE:${event.rrule.replace(/^RRULE:/i, "").replace(/[\u0000-\u001f\u007f]/g, "")}` : null;
	const parts: string[] = [];
	if (event.repeat === "daily") parts.push("FREQ=DAILY");
	else if (event.repeat === "weekly") parts.push("FREQ=WEEKLY");
	else if (event.repeat === "yearly") parts.push("FREQ=YEARLY");
	else if (event.repeat === "monthly") {
		parts.push("FREQ=MONTHLY");
		if (event.repeatWeekday != null && event.repeatWeek != null) parts.push(`BYDAY=${event.repeatWeek}${BYDAY[event.repeatWeekday]}`);
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
	// repeatUntil is an exclusive bound in the app; RFC 5545 UNTIL is inclusive, so stop one second earlier. An all-day series needs a DATE here (RFC 5545 3.3.10): the last day is the one before the bound.
	if (event.repeatUntil) {
		const last = new Date(event.repeatUntil.getTime() - 1000);
		parts.push(`UNTIL=${event.allDay ? local(last, zone ?? "UTC").slice(0, 8) : utc(last)}`);
	}
	return `RRULE:${parts.join(";")}`;
}

/**
 * The zone a VEVENT's date-times are written in: recurring events, overrides and all-day events carry one, others are UTC.
 * An all-day event without a zone of its own takes `fallbackZone` (the user's), so its dates are the ones its midnights are in.
 */
export function eventZone(event: FeedEvent, recurrenceId?: Date | null, fallbackZone?: string | null): string | null {
	const own = validTimeZone(event.timeZone);
	if (event.allDay) return own ?? validTimeZone(fallbackZone);
	return recurrenceRule(event, own) || recurrenceId ? own : null;
}

/**
 * The lines of one VEVENT. `stamp` is DTSTAMP, passed in so output is deterministic. `recurrenceId` makes it an
 * override of one occurrence of a series (the row then repeats `none`). `uid` replaces the default `<id>@mailflare`.
 */
export function buildVevent(event: FeedEvent, options: { stamp: string; recurrenceId?: Date | null; uid?: string; fallbackZone?: string | null; alarm?: boolean }): string[] {
	// Recurring events keep their local clock time across daylight saving changes only when they carry a zone.
	const zone = eventZone(event, options.recurrenceId, options.fallbackZone);
	const rule = recurrenceRule(event, zone);
	const allDay = !!event.allDay;
	const lines = ["BEGIN:VEVENT", `UID:${options.uid ?? `${event.id}@mailflare`}`, `DTSTAMP:${options.stamp}`];
	if (options.recurrenceId) lines.push(dateProperty("RECURRENCE-ID", options.recurrenceId, zone, allDay));
	lines.push(dateProperty("DTSTART", event.startsAt, zone, allDay), dateProperty("DTEND", event.endsAt, zone, allDay), `SUMMARY:${escapeIcsText(event.title)}`);
	if (event.description) lines.push(`DESCRIPTION:${escapeIcsText(event.description)}`);
	if (event.location) lines.push(`LOCATION:${escapeIcsText(event.location)}`);
	if (rule) {
		lines.push(rule);
		for (const excluded of parseExcludedOccurrences(event.excludedOccurrences)) lines.push(dateProperty("EXDATE", new Date(excluded), zone, allDay));
	}
	if (event.responseStatus === "tentative") lines.push("STATUS:TENTATIVE");
	if (event.updatedAt) lines.push(`LAST-MODIFIED:${utc(event.updatedAt)}`);
	if (options.alarm && event.reminderMinutes !== null && event.reminderMinutes !== undefined) {
		lines.push("BEGIN:VALARM", "ACTION:DISPLAY", `DESCRIPTION:${escapeIcsText(event.title || "Reminder")}`, `TRIGGER:${event.reminderMinutes ? `-PT${event.reminderMinutes}M` : "PT0S"}`, "END:VALARM");
	}
	lines.push("END:VEVENT");
	return lines;
}

export function buildCalendarFeed(events: FeedEvent[], options: { name: string; now?: Date }, overrides?: Map<string, FeedOccurrenceOverride[]>): string {
	const stamp = utc(options.now ?? new Date());
	const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Mailflare//Calendar//EN", "CALSCALE:GREGORIAN", "METHOD:PUBLISH",
		`X-WR-CALNAME:${escapeIcsText(options.name)}`, "REFRESH-INTERVAL;VALUE=DURATION:PT1H", "X-PUBLISHED-TTL:PT1H"];
	for (const event of events) {
		lines.push(...buildVevent(event, { stamp }));
		// PUBLISH stays VALARM-free and attendee-free: overrides carry only the replacement time.
		const excluded = new Set(parseExcludedOccurrences(event.excludedOccurrences));
		const zone = eventZone(event);
		for (const override of overrides?.get(event.id) ?? []) {
			if (excluded.has(override.occurrenceMs)) continue;
			lines.push("BEGIN:VEVENT", `UID:${event.id}@mailflare`, `DTSTAMP:${stamp}`,
				// The same TZID form as the master's DTSTART, so the RECURRENCE-ID pairs with its rule occurrence.
				dateProperty("RECURRENCE-ID", new Date(override.occurrenceMs), zone, !!event.allDay),
				dateProperty("DTSTART", override.startsAt, zone, !!event.allDay), dateProperty("DTEND", override.endsAt, zone, !!event.allDay),
				`SUMMARY:${escapeIcsText(event.title)}`, "END:VEVENT");
		}
	}
	lines.push("END:VCALENDAR");
	return joinIcsLines(lines);
}

import { escapeIcsText, foldIcsLine, formatIcsUtc, joinIcsLines } from "./ics";
import { parseCalendarRepeatDays, parseExcludedOccurrences } from "./recurrence";

export { escapeIcsText, foldIcsLine };

export type FeedEvent = {
	id: string;
	title: string;
	description: string;
	location: string;
	startsAt: Date;
	endsAt: Date;
	repeat: "none" | "daily" | "weekly" | "monthly" | "weekdays" | "custom";
	rrule?: string | null;
	repeatDays: string;
	repeatAnchorDay: number | null;
	repeatUntil: Date | null;
	excludedOccurrences: string;
	timeZone: string | null;
	attendees: string;
	updatedAt?: Date | null;
	responseStatus?: string | null;
	/** A DATE value (no time of day) in `timeZone`; the stored instants are midnight to midnight. */
	allDay?: boolean;
	/** CLASS:PRIVATE; written only when set, so an ordinary event renders as it always did. */
	isPrivate?: boolean;
	/** TRANSP:TRANSPARENT (shown as free); written only when set. */
	transparent?: boolean;
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

function recurrenceRule(event: FeedEvent, zone: string | null): string | null {
	if (event.repeat === "none") return null;
	if (event.repeat === "custom") return event.rrule ? `RRULE:${event.rrule.replace(/^RRULE:/i, "").replace(/[\u0000-\u001f\u007f]/g, "")}` : null;
	const parts: string[] = [];
	if (event.repeat === "daily") parts.push("FREQ=DAILY");
	else if (event.repeat === "weekly") parts.push("FREQ=WEEKLY");
	else if (event.repeat === "monthly") {
		parts.push("FREQ=MONTHLY");
		if (event.repeatAnchorDay) parts.push(`BYMONTHDAY=${event.repeatAnchorDay}`);
	} else {
		const days = parseCalendarRepeatDays(event.repeatDays);
		if (!days.length) return null;
		parts.push("FREQ=WEEKLY", `BYDAY=${days.map((day) => BYDAY[day]).join(",")}`);
	}
	// An all-day series needs a DATE here (RFC 5545 3.3.10): `repeatUntil` is the exclusive bound, so the last day is the one before it.
	if (event.repeatUntil) parts.push(`UNTIL=${event.allDay ? local(new Date(event.repeatUntil.getTime() - 1000), zone ?? "UTC").slice(0, 8) : utc(event.repeatUntil)}`);
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
	if (event.isPrivate) lines.push("CLASS:PRIVATE");
	if (event.transparent) lines.push("TRANSP:TRANSPARENT");
	if (event.updatedAt) lines.push(`LAST-MODIFIED:${utc(event.updatedAt)}`);
	if (options.alarm && event.reminderMinutes !== null && event.reminderMinutes !== undefined) {
		lines.push("BEGIN:VALARM", "ACTION:DISPLAY", `DESCRIPTION:${escapeIcsText(event.title || "Reminder")}`, `TRIGGER:${event.reminderMinutes ? `-PT${event.reminderMinutes}M` : "PT0S"}`, "END:VALARM");
	}
	lines.push("END:VEVENT");
	return lines;
}

export function buildCalendarFeed(events: FeedEvent[], options: { name: string; now?: Date }): string {
	const stamp = utc(options.now ?? new Date());
	const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Mailflare//Calendar//EN", "CALSCALE:GREGORIAN", "METHOD:PUBLISH",
		`X-WR-CALNAME:${escapeIcsText(options.name)}`, "REFRESH-INTERVAL;VALUE=DURATION:PT1H", "X-PUBLISHED-TTL:PT1H"];
	for (const event of events) lines.push(...buildVevent(event, { stamp }));
	lines.push("END:VCALENDAR");
	return joinIcsLines(lines);
}

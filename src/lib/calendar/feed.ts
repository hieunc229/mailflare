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
	repeat: "none" | "daily" | "weekly" | "monthly" | "weekdays";
	repeatDays: string;
	repeatAnchorDay: number | null;
	repeatUntil: Date | null;
	excludedOccurrences: string;
	timeZone: string | null;
	attendees: string;
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

function recurrenceRule(event: FeedEvent): string | null {
	if (event.repeat === "none") return null;
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
	if (event.repeatUntil) parts.push(`UNTIL=${utc(event.repeatUntil)}`);
	return `RRULE:${parts.join(";")}`;
}

export function buildCalendarFeed(events: FeedEvent[], options: { name: string; now?: Date }): string {
	const stamp = utc(options.now ?? new Date());
	const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Mailflare//Calendar//EN", "CALSCALE:GREGORIAN", "METHOD:PUBLISH",
		`X-WR-CALNAME:${escapeIcsText(options.name)}`, "REFRESH-INTERVAL;VALUE=DURATION:PT1H", "X-PUBLISHED-TTL:PT1H"];
	for (const event of events) {
		const rule = recurrenceRule(event);
		// Recurring events keep their local clock time across daylight saving changes only when they carry a zone.
		const zone = rule ? validTimeZone(event.timeZone) : null;
		lines.push("BEGIN:VEVENT", `UID:${event.id}@mailflare`, `DTSTAMP:${stamp}`,
			dateProperty("DTSTART", event.startsAt, zone), dateProperty("DTEND", event.endsAt, zone),
			`SUMMARY:${escapeIcsText(event.title)}`);
		if (event.description) lines.push(`DESCRIPTION:${escapeIcsText(event.description)}`);
		if (event.location) lines.push(`LOCATION:${escapeIcsText(event.location)}`);
		if (rule) {
			lines.push(rule);
			for (const excluded of parseExcludedOccurrences(event.excludedOccurrences)) lines.push(dateProperty("EXDATE", new Date(excluded), zone));
		}
		if (event.responseStatus === "tentative") lines.push("STATUS:TENTATIVE");
		if (event.updatedAt) lines.push(`LAST-MODIFIED:${utc(event.updatedAt)}`);
		lines.push("END:VEVENT");
	}
	lines.push("END:VCALENDAR");
	return joinIcsLines(lines);
}

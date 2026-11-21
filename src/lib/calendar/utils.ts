import { escapeIcsText, formatIcsUtc, isIcsAddress, joinIcsLines } from "./ics";

type CalendarInvitationInput = {
	title: string;
	description: string;
	location: string;
	startsAt: Date;
	endsAt: Date;
	uid: string;
	/** PUBLISH is a plain event to add to a calendar, without organizer or RSVP. */
	method?: "REQUEST" | "CANCEL" | "PUBLISH";
	organizer?: string;
	attendees?: string[];
	/** Reminder minutes before the start; null/undefined writes no VALARM. */
	reminderMinutes?: number | null;
	/** Revision of this invitation: 0 for a new UID, bumped on every update so guests ignore stale mail. */
	sequence: number;
	/** Recurrence of the series; absent or "none" writes no RRULE. */
	repeat?: "none" | "daily" | "weekly" | "monthly" | "weekdays" | "yearly";
	/** Listed weekdays (0-6) of a weekdays repeat. */
	repeatDays?: number[];
	/** Month day (1-31) of a plain monthly repeat. */
	repeatAnchorDay?: number | null;
	/** Exclusive end of the series; written as the RRULE UNTIL in UTC. */
	repeatUntil?: Date | null;
	/** Step between recurrences: every N days/weeks/months/years. */
	repeatInterval?: number | null;
	/** Weekday (0-6) and week (1-5, -1 = last) of an nth-weekday monthly repeat. */
	repeatWeekday?: number | null;
	repeatWeek?: number | null;
	/** Starts (epoch ms) of cancelled occurrences; written as EXDATE in UTC. */
	excludedOccurrences?: number[];
	/** Moved or added occurrences; each becomes a VEVENT with RECURRENCE-ID in UTC. */
	overrides?: { recurrenceId: Date; startsAt: Date; endsAt: Date }[];
};

const INVITE_BYDAY = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];

function invitationRecurrenceRule(input: CalendarInvitationInput): string | null {
	if (!input.repeat || input.repeat === "none") return null;
	const parts: string[] = [];
	// A listed-days repeat steps day by day, so its interval is always 1 and never written.
	const interval = input.repeat === "weekdays" ? 1 : input.repeatInterval;
	if (input.repeat === "daily") parts.push("FREQ=DAILY");
	else if (input.repeat === "weekly") parts.push("FREQ=WEEKLY");
	else if (input.repeat === "yearly") parts.push("FREQ=YEARLY");
	else if (input.repeat === "monthly") {
		parts.push("FREQ=MONTHLY");
		if (input.repeatWeekday != null && input.repeatWeek != null && Number.isInteger(input.repeatWeekday) && input.repeatWeekday >= 0 && input.repeatWeekday <= 6 && Number.isInteger(input.repeatWeek) && ((input.repeatWeek >= 1 && input.repeatWeek <= 5) || input.repeatWeek === -1)) parts.push(`BYDAY=${input.repeatWeek}${INVITE_BYDAY[input.repeatWeekday]}`);
		else if (input.repeatAnchorDay) parts.push(`BYMONTHDAY=${input.repeatAnchorDay}`);
	} else {
		const days = [...new Set((input.repeatDays ?? []).filter((day) => Number.isInteger(day) && day >= 0 && day <= 6))].sort((a, b) => a - b);
		if (!days.length) return null;
		parts.push("FREQ=WEEKLY", `BYDAY=${days.map((day) => INVITE_BYDAY[day]).join(",")}`);
	}
	if (Number.isInteger(interval) && (interval as number) > 1) parts.push(`INTERVAL=${interval}`);
	if (input.repeatUntil) parts.push(`UNTIL=${formatIcsUtc(input.repeatUntil)}`);
	return `RRULE:${parts.join(";")}`;
}

export function createCalendarInvitation(input: CalendarInvitationInput): ArrayBuffer {
	const organizer = input.method !== "PUBLISH" && input.organizer && isIcsAddress(input.organizer) ? input.organizer : null;
	const sequence = Number.isSafeInteger(input.sequence) && (input.sequence as number) >= 0 ? (input.sequence as number) : 0;
	const stamp = formatIcsUtc(new Date());
	const rule = invitationRecurrenceRule(input);
	const excluded = [...new Set((input.excludedOccurrences ?? []).filter((ms) => Number.isSafeInteger(ms) && ms >= 0))].sort((a, b) => a - b);
	const organizerLine = organizer ? [`ORGANIZER:mailto:${organizer}`] : [];
	const attendeeLines = organizer ? (input.attendees ?? []).filter((address) => isIcsAddress(address)).map((address) => `ATTENDEE;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:${address}`) : [];
	const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Mailflare//Calendar//EN", "CALSCALE:GREGORIAN", `METHOD:${input.method ?? "REQUEST"}`, "BEGIN:VEVENT", `UID:${input.uid}@mailflare`, `DTSTAMP:${stamp}`, `SEQUENCE:${sequence}`, `DTSTART:${formatIcsUtc(input.startsAt)}`, `DTEND:${formatIcsUtc(input.endsAt)}`, `SUMMARY:${escapeIcsText(input.title)}`, `DESCRIPTION:${escapeIcsText(input.description)}`, `LOCATION:${escapeIcsText(input.location)}`,
		...(organizerLine),
		...attendeeLines,
		...(rule ? [rule] : []),
		...(excluded.length ? [`EXDATE:${excluded.map((ms) => formatIcsUtc(new Date(ms))).join(",")}`] : []),
		// One best-effort reminder; -PTnM is always a valid DURATION, so large offsets stay in minutes.
		...(input.reminderMinutes != null ? ["BEGIN:VALARM", "ACTION:DISPLAY", `DESCRIPTION:${escapeIcsText(input.title)}`, `TRIGGER:-PT${input.reminderMinutes}M`, "END:VALARM"] : []),
		"END:VEVENT"];
	for (const override of input.overrides ?? []) {
		lines.push("BEGIN:VEVENT", `UID:${input.uid}@mailflare`, `DTSTAMP:${stamp}`, `SEQUENCE:${sequence}`, `RECURRENCE-ID:${formatIcsUtc(override.recurrenceId)}`, `DTSTART:${formatIcsUtc(override.startsAt)}`, `DTEND:${formatIcsUtc(override.endsAt)}`, `SUMMARY:${escapeIcsText(input.title)}`, `DESCRIPTION:${escapeIcsText(input.description)}`, `LOCATION:${escapeIcsText(input.location)}`, ...organizerLine, ...attendeeLines, "END:VEVENT");
	}
	lines.push("END:VCALENDAR");
	return new TextEncoder().encode(joinIcsLines(lines)).buffer as ArrayBuffer;
}

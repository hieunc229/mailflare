import { escapeIcsText, formatIcsUtc, ICS_ADDRESS, joinIcsLines } from "./ics";

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
	/** Revision of this invitation: 0 for a new UID, 1 for an update to an existing one. */
	sequence?: number;
};

export function createCalendarInvitation(input: CalendarInvitationInput): ArrayBuffer {
	const organizer = input.method !== "PUBLISH" && input.organizer && ICS_ADDRESS.test(input.organizer) ? input.organizer : null;
	const sequence = Number.isSafeInteger(input.sequence) && (input.sequence as number) >= 0 ? (input.sequence as number) : 0;
	const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Mailflare//Calendar//EN", "CALSCALE:GREGORIAN", `METHOD:${input.method ?? "REQUEST"}`, "BEGIN:VEVENT", `UID:${input.uid}@mailflare`, `DTSTAMP:${formatIcsUtc(new Date())}`, `SEQUENCE:${sequence}`, `DTSTART:${formatIcsUtc(input.startsAt)}`, `DTEND:${formatIcsUtc(input.endsAt)}`, `SUMMARY:${escapeIcsText(input.title)}`, `DESCRIPTION:${escapeIcsText(input.description)}`, `LOCATION:${escapeIcsText(input.location)}`,
		...(organizer ? [`ORGANIZER:mailto:${organizer}`] : []),
		...(organizer ? (input.attendees ?? []).filter((address) => ICS_ADDRESS.test(address)).map((address) => `ATTENDEE;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:${address}`) : []),
		// One best-effort reminder; -PTnM is always a valid DURATION, so large offsets stay in minutes.
		...(input.reminderMinutes != null ? ["BEGIN:VALARM", "ACTION:DISPLAY", `DESCRIPTION:${escapeIcsText(input.title)}`, `TRIGGER:-PT${input.reminderMinutes}M`, "END:VALARM"] : []),
		"END:VEVENT", "END:VCALENDAR"];
	return new TextEncoder().encode(joinIcsLines(lines)).buffer as ArrayBuffer;
}

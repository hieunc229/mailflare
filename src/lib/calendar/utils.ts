import { escapeIcsText, formatIcsUtc, ICS_ADDRESS, joinIcsLines } from "./ics";

type CalendarInvitationInput = {
	title: string;
	description: string;
	location: string;
	startsAt: Date;
	endsAt: Date;
	uid: string;
	method?: "REQUEST" | "CANCEL";
	organizer?: string;
	attendees?: string[];
};

export function createCalendarInvitation(input: CalendarInvitationInput): ArrayBuffer {
	const organizer = input.organizer && ICS_ADDRESS.test(input.organizer) ? input.organizer : null;
	const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Mailflare//Calendar//EN", "CALSCALE:GREGORIAN", `METHOD:${input.method ?? "REQUEST"}`, "BEGIN:VEVENT", `UID:${input.uid}@mailflare`, `DTSTAMP:${formatIcsUtc(new Date())}`, `DTSTART:${formatIcsUtc(input.startsAt)}`, `DTEND:${formatIcsUtc(input.endsAt)}`, `SUMMARY:${escapeIcsText(input.title)}`, `DESCRIPTION:${escapeIcsText(input.description)}`, `LOCATION:${escapeIcsText(input.location)}`,
		...(organizer ? [`ORGANIZER:mailto:${organizer}`] : []),
		...(organizer ? (input.attendees ?? []).filter((address) => ICS_ADDRESS.test(address)).map((address) => `ATTENDEE;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:${address}`) : []),
		"END:VEVENT", "END:VCALENDAR"];
	return new TextEncoder().encode(joinIcsLines(lines)).buffer as ArrayBuffer;
}

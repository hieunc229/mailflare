import { createCalendarInvitation } from "@/lib/calendar/utils";

export type BookingConfirmationContent = {
	eventName: string;
	hostName: string;
	guestName: string;
	location: string;
	notes: string;
	startsAt: Date;
	endsAt: Date;
	timeZone: string;
};

/** The names a confirmation can use as {placeholder}. */
export const BOOKING_TEMPLATE_PLACEHOLDERS = ["guestName", "eventName", "hostName", "when", "location", "notes"] as const;
export type BookingTemplatePlaceholder = (typeof BOOKING_TEMPLATE_PLACEHOLDERS)[number];
export type BookingConfirmationTemplate = { subject: string; body: string };

export const CONFIRMATION_SUBJECT_MAX = 200;
export const CONFIRMATION_BODY_MAX = 5000;

/**
 * The built-in confirmation, used for whichever of subject and body an event leaves empty. It deliberately leaves out
 * {notes}: the booking page is public, so the booker's free text must not appear in mail sent from the host's address
 * unless the host chose to put it there in a custom template.
 */
export const DEFAULT_CONFIRMATION_SUBJECT = "Confirmed: {eventName} with {hostName}";
export const DEFAULT_CONFIRMATION_BODY = [
	"Hi {guestName},",
	"",
	"your booking is confirmed: {eventName} with {hostName}.",
	"",
	"When: {when}",
	"Where: {location}",
	"",
	"The attached calendar file adds the meeting to your calendar. Reply to this email if you need to change or cancel it.",
].join("\n");

const FALLBACK_LOCALE = "en-GB";

/** The locale for {when}: the language the guest picked on the booking page, else their browser's, else English. */
export function pickGuestLocale(localeCookie: string | null | undefined, acceptLanguage: string | null | undefined): string {
	const candidates = [localeCookie, ...(acceptLanguage ?? "").split(",").map((part) => part.split(";")[0])];
	for (const candidate of candidates) {
		const tag = candidate?.trim();
		if (!tag || tag === "*") continue;
		try {
			if (Intl.DateTimeFormat.supportedLocalesOf([tag]).length) return tag;
		} catch {
			// Not a valid language tag; try the next one.
		}
	}
	return FALLBACK_LOCALE;
}

/** "Friday 13 November 2026, 10:00–10:30 (Europe/Berlin)" in the event's time zone, worded for the guest's locale. */
export function formatBookingWhen(startsAt: Date, endsAt: Date, timeZone: string, locale = FALLBACK_LOCALE): string {
	let zone = timeZone;
	try {
		new Intl.DateTimeFormat(locale, { timeZone: zone });
	} catch {
		zone = "UTC";
	}
	const day = new Intl.DateTimeFormat(locale, { timeZone: zone, weekday: "long", day: "numeric", month: "long", year: "numeric" }).format(startsAt);
	const time = new Intl.DateTimeFormat(locale, { timeZone: zone, hour: "2-digit", minute: "2-digit" });
	return `${day}, ${time.format(startsAt)}–${time.format(endsAt)} (${zone})`;
}

/**
 * Replaces known {placeholders}; anything else in braces is left as written. A line whose placeholders all come out
 * empty is dropped, so "Where: {location}" disappears for an event without a location.
 */
export function renderBookingTemplate(template: string, values: Record<BookingTemplatePlaceholder, string>): string {
	const known = (name: string): name is BookingTemplatePlaceholder => Object.hasOwn(values, name);
	return template
		.split("\n")
		.filter((line) => {
			const names = [...line.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).filter(known);
			return !names.length || names.some((name) => values[name].trim());
		})
		.map((line) => line.replace(/\{(\w+)\}/g, (match, name: string) => (known(name) ? values[name] : match)))
		.join("\n");
}

/**
 * Reads the confirmation fields of a booking event request: undefined when the request leaves them out (keep what
 * is saved), null when they are invalid.
 */
export function parseConfirmationTemplateInput(value: unknown): BookingConfirmationTemplate | null | undefined {
	if (!value || typeof value !== "object") return undefined;
	const input = value as Record<string, unknown>;
	if (input.confirmationSubject === undefined && input.confirmationBody === undefined) return undefined;
	const subject = input.confirmationSubject ?? "";
	const body = input.confirmationBody ?? "";
	if (typeof subject !== "string" || typeof body !== "string") return null;
	const cleanSubject = subject.replace(/[\r\n]+/g, " ").trim();
	const cleanBody = body.replace(/\r\n?/g, "\n").trim();
	if (cleanSubject.length > CONFIRMATION_SUBJECT_MAX || cleanBody.length > CONFIRMATION_BODY_MAX) return null;
	return { subject: cleanSubject, body: cleanBody };
}

/** The guest confirmation: the event's own subject and body where set, the default template otherwise. */
export function buildBookingConfirmation(content: BookingConfirmationContent, locale = FALLBACK_LOCALE, template?: BookingConfirmationTemplate | null): { subject: string; text: string } {
	// The booker is anonymous: keep their name on one line so it cannot add lines to the message or subject.
	const values = {
		guestName: content.guestName.replace(/\s+/g, " ").trim(),
		eventName: content.eventName,
		hostName: content.hostName,
		when: formatBookingWhen(content.startsAt, content.endsAt, content.timeZone, locale),
		location: content.location,
		notes: content.notes,
	};
	// A guest's name can go into the subject, so keep it on one header line whatever they typed.
	const oneLine = (value: string) => value.replace(/[\r\n]+/g, " ").trim();
	const subject = oneLine(renderBookingTemplate(template?.subject || DEFAULT_CONFIRMATION_SUBJECT, values)) || oneLine(renderBookingTemplate(DEFAULT_CONFIRMATION_SUBJECT, values));
	return { subject, text: renderBookingTemplate(template?.body || DEFAULT_CONFIRMATION_BODY, values) };
}

/**
 * The calendar file attached to the confirmation. It is a plain PUBLISH event, not a meeting request: the booking is
 * already confirmed, the guest's answer would not reach the host's events, and Outlook cannot import an attached
 * REQUEST file.
 */
export function buildBookingCalendarFile(input: { title: string; description: string; location: string; startsAt: Date; endsAt: Date; uid: string }): ArrayBuffer {
	return createCalendarInvitation({ ...input, method: "PUBLISH" });
}

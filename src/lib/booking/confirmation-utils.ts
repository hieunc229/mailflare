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

type ConfirmationText = {
	dateLocale: string;
	timeSuffix: string;
	with: string;
	subject: string;
	greeting: string;
	confirmed: string;
	when: string;
	where: string;
	notes: string;
	closing: string;
};

// The guest is not a Mailflare user, so this mail is not tied to the UI catalogs; languages fall back to English.
const TEXT = {
	en: {
		dateLocale: "en-GB",
		timeSuffix: "",
		with: "with",
		subject: "Confirmed:",
		greeting: "Hi {name},",
		confirmed: "your booking is confirmed:",
		when: "When:",
		where: "Where:",
		notes: "Your notes:",
		closing: "The attached invitation adds the meeting to your calendar. Reply to this email if you need to change or cancel it.",
	},
	de: {
		dateLocale: "de-DE",
		timeSuffix: " Uhr",
		with: "mit",
		subject: "Bestätigt:",
		greeting: "Guten Tag {name},",
		confirmed: "Ihre Buchung ist bestätigt:",
		when: "Wann:",
		where: "Wo:",
		notes: "Ihre Notizen:",
		closing: "Mit der angehängten Einladung tragen Sie den Termin in Ihren Kalender ein. Antworten Sie einfach auf diese E-Mail, wenn Sie den Termin ändern oder absagen möchten.",
	},
} satisfies Record<string, ConfirmationText>;

export type ConfirmationLanguage = keyof typeof TEXT;

function supported(tag: string | null | undefined): ConfirmationLanguage | null {
	const base = tag?.trim().toLowerCase().split(/[-_;]/)[0];
	return base && Object.hasOwn(TEXT, base) ? base as ConfirmationLanguage : null;
}

/** The language the guest picked on the booking page, else the first supported one their browser asks for, else English. */
export function pickConfirmationLanguage(localeCookie: string | null | undefined, acceptLanguage: string | null | undefined): ConfirmationLanguage {
	const chosen = supported(localeCookie);
	if (chosen) return chosen;
	for (const part of (acceptLanguage ?? "").split(",")) {
		const match = supported(part);
		if (match) return match;
	}
	return "en";
}

/** "Friday, 13 November 2026, 10:00–10:30 (Europe/Berlin)" in the booking event's own time zone. */
export function formatBookingWhen(startsAt: Date, endsAt: Date, timeZone: string, language: ConfirmationLanguage = "en"): string {
	const text = TEXT[language];
	let zone = timeZone;
	try {
		new Intl.DateTimeFormat(text.dateLocale, { timeZone: zone });
	} catch {
		zone = "UTC";
	}
	const day = new Intl.DateTimeFormat(text.dateLocale, { timeZone: zone, weekday: "long", day: "numeric", month: "long", year: "numeric" }).format(startsAt);
	const time = new Intl.DateTimeFormat(text.dateLocale, { timeZone: zone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
	return `${day}, ${time.format(startsAt)}–${time.format(endsAt)}${text.timeSuffix} (${zone})`;
}

/** "Intro call with Paul" in the guest's language, used for the subject and the invitation title. */
export function bookingMeetingTitle(eventName: string, hostName: string, language: ConfirmationLanguage = "en"): string {
	return `${eventName} ${TEXT[language].with} ${hostName}`;
}

/** The names a custom confirmation can use as {placeholder}. */
export const BOOKING_TEMPLATE_PLACEHOLDERS = ["guestName", "eventName", "hostName", "when", "location", "notes"] as const;
export type BookingTemplatePlaceholder = (typeof BOOKING_TEMPLATE_PLACEHOLDERS)[number];
export type BookingConfirmationTemplate = { subject: string; body: string };

export const CONFIRMATION_SUBJECT_MAX = 200;
export const CONFIRMATION_BODY_MAX = 5000;

/** Replaces known {placeholders}; anything else in braces is left as written. */
export function renderBookingTemplate(template: string, values: Record<BookingTemplatePlaceholder, string>): string {
	return template.replace(/\{(\w+)\}/g, (match, name: string) => (Object.hasOwn(values, name) ? values[name as BookingTemplatePlaceholder] : match));
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

/** The guest confirmation: the event's own subject and body where set, the built-in text otherwise. */
export function buildBookingConfirmation(content: BookingConfirmationContent, language: ConfirmationLanguage = "en", template?: BookingConfirmationTemplate | null): { subject: string; text: string } {
	const text = TEXT[language];
	const title = bookingMeetingTitle(content.eventName, content.hostName, language);
	const when = formatBookingWhen(content.startsAt, content.endsAt, content.timeZone, language);
	const values = { guestName: content.guestName, eventName: content.eventName, hostName: content.hostName, when, location: content.location, notes: content.notes };
	// A guest's name goes into the subject, so keep it on one header line whatever they typed.
	const subject = (template?.subject ? renderBookingTemplate(template.subject, values) : `${text.subject} ${title}`).replace(/[\r\n]+/g, " ").trim();
	if (template?.body) return { subject, text: renderBookingTemplate(template.body, values) };
	const lines = [
		text.greeting.replace("{name}", content.guestName),
		"",
		`${text.confirmed} ${title}.`,
		"",
		`${text.when} ${when}`,
		...(content.location ? [`${text.where} ${content.location}`] : []),
		...(content.notes ? ["", text.notes, content.notes] : []),
		"",
		text.closing,
	];
	return { subject, text: lines.join("\n") };
}

/**
 * The calendar file attached to the confirmation. It is a plain PUBLISH event, not a meeting request: the booking is
 * already confirmed, the guest's answer would not reach the host's events, and Outlook cannot import an attached
 * REQUEST file.
 */
export function buildBookingCalendarFile(input: { title: string; description: string; location: string; startsAt: Date; endsAt: Date; uid: string }): ArrayBuffer {
	return createCalendarInvitation({ ...input, method: "PUBLISH" });
}

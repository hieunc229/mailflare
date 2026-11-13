import { eq, inArray } from "drizzle-orm";
import type { getDb } from "@/db";
import { bookingConfirmationTemplates } from "@/db/schema";
import { isMissingTableError } from "@/lib/database-errors";
import type { BookingConfirmationTemplate } from "./confirmation-utils";

type Db = ReturnType<typeof getDb>;

/** Thrown when a custom confirmation is saved before the migration that adds its table. */
export class ConfirmationTemplatesUnavailableError extends Error {
	constructor() {
		super("Apply the pending database migration (Admin → Overview) before customizing the confirmation email.");
	}
}

/** Custom confirmations by booking event id. Before the migration there are none. */
export async function getConfirmationTemplates(db: Db, eventIds: string[]): Promise<Map<string, BookingConfirmationTemplate>> {
	if (!eventIds.length) return new Map();
	try {
		const rows = await db
			.select({ eventId: bookingConfirmationTemplates.eventId, subject: bookingConfirmationTemplates.subject, body: bookingConfirmationTemplates.body })
			.from(bookingConfirmationTemplates)
			.where(inArray(bookingConfirmationTemplates.eventId, eventIds));
		return new Map(rows.map((row) => [row.eventId, { subject: row.subject, body: row.body }]));
	} catch (error) {
		if (isMissingTableError(error)) return new Map();
		throw error;
	}
}

/** Saves an event's confirmation; an empty subject and body remove it so the built-in text is used again. */
export async function saveConfirmationTemplate(db: Db, eventId: string, template: BookingConfirmationTemplate): Promise<void> {
	try {
		if (!template.subject && !template.body) {
			await db.delete(bookingConfirmationTemplates).where(eq(bookingConfirmationTemplates.eventId, eventId));
			return;
		}
		const values = { subject: template.subject, body: template.body, updatedAt: new Date() };
		await db.insert(bookingConfirmationTemplates).values({ eventId, ...values }).onConflictDoUpdate({ target: bookingConfirmationTemplates.eventId, set: values });
	} catch (error) {
		if (!isMissingTableError(error)) throw error;
		if (template.subject || template.body) throw new ConfirmationTemplatesUnavailableError();
	}
}

/** Adds each event's confirmationSubject and confirmationBody, empty where it has none. */
export async function withConfirmationTemplates<T extends { id: string }>(db: Db, events: T[]): Promise<(T & { confirmationSubject: string; confirmationBody: string })[]> {
	const templates = await getConfirmationTemplates(db, events.map((event) => event.id));
	return events.map((event) => ({ ...event, confirmationSubject: templates.get(event.id)?.subject ?? "", confirmationBody: templates.get(event.id)?.body ?? "" }));
}

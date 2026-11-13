import { and, asc, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { domains, mailboxes, users } from "@/db/schema";
import { sendEmail } from "@/lib/email/send";
import { newId } from "@/lib/ids";
import { mailboxAddress } from "@/lib/profile/identity-utils";
import { buildBookingCalendarFile, buildBookingConfirmation } from "./confirmation-utils";
import { getConfirmationTemplates } from "./confirmation-templates";
import type { BookingEventRecord } from "./types";

/** The event owner's own mailbox: the one at their account address, else their oldest personal one. */
async function findHostMailbox(env: CloudflareEnv, userId: string): Promise<{ id: string; address: string } | null> {
	const db = getDb(env);
	const rows = await db
		.select({ id: mailboxes.id, localPart: mailboxes.localPart, hostname: domains.hostname, accountEmail: users.email })
		.from(mailboxes)
		.innerJoin(domains, eq(mailboxes.domainId, domains.id))
		.innerJoin(users, eq(mailboxes.userId, users.id))
		.where(and(eq(mailboxes.userId, userId), eq(mailboxes.type, "personal"), eq(mailboxes.disabled, false)))
		.orderBy(asc(mailboxes.createdAt));
	const chosen = rows.find((row) => mailboxAddress(row) === row.accountEmail?.trim().toLowerCase()) ?? rows[0];
	return chosen ? { id: chosen.id, address: mailboxAddress(chosen) } : null;
}

/**
 * Emails the booker a confirmation with an invite.ics, from the event owner's mailbox, so replies reach the host and
 * a Sent copy is kept. Guests the booker added are not mailed: the public page does not verify addresses, so mailing
 * them would let anyone send mail from the host's address to third parties. Delivery goes through the outbound queue a few seconds later,
 * keeping the public booking request light. Never throws: the booking already stands.
 */
export async function sendBookingConfirmation(
	env: CloudflareEnv,
	input: { event: BookingEventRecord; hostName: string; guestName: string; guestEmail: string; notes: string; startsAt: string; endsAt: string; locale?: string; publicOrigin?: string },
): Promise<boolean> {
	try {
		const mailbox = await findHostMailbox(env, input.event.userId);
		if (!mailbox) {
			console.warn("Booking confirmation skipped: the event owner has no personal mailbox", { eventId: input.event.id });
			return false;
		}
		const startsAt = new Date(input.startsAt);
		const endsAt = new Date(input.endsAt);
		const template = (await getConfirmationTemplates(getDb(env), [input.event.id])).get(input.event.id);
		const { subject, text } = buildBookingConfirmation({
			eventName: input.event.name,
			hostName: input.hostName,
			guestName: input.guestName,
			location: input.event.location,
			notes: input.notes,
			startsAt,
			endsAt,
			timeZone: input.event.timeZone,
		}, input.locale, template);
		const invite = buildBookingCalendarFile({
			// Worded without language so it reads the same whatever text the host chose.
			title: `${input.event.name} (${input.hostName})`,
			description: input.event.description || text,
			location: input.event.location,
			startsAt,
			endsAt,
			uid: newId("bkg"),
		});
		await sendEmail(env, {
			userId: input.event.userId,
			mailboxId: mailbox.id,
			from: mailbox.address,
			to: input.guestEmail,
			subject,
			text,
			attachments: [{ filename: "invite.ics", type: "text/calendar; charset=utf-8", content: invite }],
			scheduledAt: new Date(Date.now() + 5_000),
			publicOrigin: input.publicOrigin,
		});
		return true;
	} catch (error) {
		console.error("Booking confirmation failed", { eventId: input.event.id, error });
		return false;
	}
}

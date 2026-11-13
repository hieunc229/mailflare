import { and, desc, eq, isNotNull, isNull } from "drizzle-orm";
import { getDb } from "@/db";
import { calendarEvents, users } from "@/db/schema";
import type { AttachmentContent } from "@/lib/email/attachment-types";
import { inviteRepeat, parseInvite, type ParsedInvite } from "./invite";
import { findInviteAttachment, MAX_INVITE_BYTES } from "./invite-attachment";
import { addExcludedOccurrence, chooseRecipientZone, inboundNeedsRecipientZone, inviteSenderMatches, mergeExcludedOccurrences, normalizeInviteSender, planInboundInvite } from "./invite-rules";

export { findInviteAttachment };

/** One calendar row per (user, invitation UID), so a re-sent or updated invitation edits the same event. */
export async function inviteEventId(userId: string, uid: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${userId}\n${uid}`));
	return `inv_${[...new Uint8Array(digest)].slice(0, 12).map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

/**
 * Calendar columns written from an invitation. `timeZone` is the zone the event's clock time belongs to (the invitation's
 * own zone, else the recipient's); `existingExcluded` keeps occurrences already excluded when the series is refreshed.
 */
export function inviteEventValues(invite: ParsedInvite, timeZone: string | null, existingExcluded?: string | null) {
	const repeat = inviteRepeat(invite.rrule, invite.startsAt, timeZone);
	return {
		title: invite.title, description: invite.description, location: invite.location,
		attendees: "[]",
		repeat: repeat.repeat, repeatDays: JSON.stringify(repeat.repeatDays), repeatAnchorDay: repeat.repeatAnchorDay, repeatUntil: repeat.repeatUntil,
		excludedOccurrences: mergeExcludedOccurrences(existingExcluded, invite.excludedDates), timeZone,
		inviteSequence: invite.sequence,
		startsAt: invite.startsAt, endsAt: invite.endsAt, updatedAt: new Date(),
	};
}

/**
 * True when `senderAddress` is the sender whose invitation created `existing`. Both the automatic inbound path and the
 * Accept/Decline endpoint use it, so neither lets a later message from someone else rewrite or remove the event.
 * The sender is stored on the row, so deleting the original email does not orphan the event. A row without a stored
 * sender fails closed.
 */
export function sameInviteSender(existing: { inviteSender?: string | null }, senderAddress: string): boolean {
	return inviteSenderMatches(existing, senderAddress);
}

/**
 * The one source of the recipient's zone for invitation times, used by both the inbound path and the invitation
 * route: the account's saved zone, else the zone of their most recently updated calendar event that has one, else null.
 */
export async function recipientInviteTimeZone(db: ReturnType<typeof getDb>, userId: string): Promise<string | null> {
	const [user] = await db.select({ timeZone: users.timeZone }).from(users).where(eq(users.id, userId)).limit(1);
	const saved = chooseRecipientZone(user?.timeZone, null);
	if (saved) return saved;
	const [latest] = await db.select({ timeZone: calendarEvents.timeZone }).from(calendarEvents)
		// Only events the user made count: an invitation row carries the sender's zone, which a sender could use to steer how
		// the next all-day or floating invitation is read.
		.where(and(eq(calendarEvents.userId, userId), isNotNull(calendarEvents.timeZone), isNull(calendarEvents.inviteMessageId), isNull(calendarEvents.responseStatus)))
		.orderBy(desc(calendarEvents.updatedAt)).limit(1);
	return chooseRecipientZone(null, latest?.timeZone);
}

/**
 * Called when mail arrives. A new invitation becomes a pending event on the recipient's calendar,
 * an updated one refreshes the same event (and asks again if the time moved), a cancellation removes it.
 * It must never make delivery fail, so every error is logged and swallowed.
 */
export async function registerInboundInvite(env: CloudflareEnv, input: { userId: string; mailboxId: string; messageId: string; senderAddress: string; attachments: AttachmentContent[] }): Promise<void> {
	try {
		const attachment = findInviteAttachment(input.attachments);
		if (!attachment || attachment.content.byteLength > MAX_INVITE_BYTES) return;
		const db = getDb(env);
		const recipientZone = await recipientInviteTimeZone(db, input.userId);
		const invite = parseInvite(new TextDecoder().decode(attachment.content), { timeZone: recipientZone ?? "UTC" });
		if (!invite || (invite.method !== "REQUEST" && invite.method !== "CANCEL" && invite.method !== "REPLY")) return;
		// All-day or floating times read without knowing the recipient's zone would land at the wrong time (and a refresh
		// would look like a move), so such an invitation waits for the user to answer it from the message instead.
		if (!recipientZone && inboundNeedsRecipientZone(invite)) return;
		const userZone = recipientZone ?? "UTC";
		if (invite.method === "REPLY") {
			await applyInviteReply(env, input.userId, input.senderAddress, invite);
			return;
		}
		// Mailflare writes UID <event id>@mailflare; an invitation you sent yourself is already your own event.
		const ownId = invite.uid.endsWith("@mailflare") ? invite.uid.slice(0, -"@mailflare".length) : null;
		if (ownId) {
			const [own] = await db.select({ id: calendarEvents.id }).from(calendarEvents).where(and(eq(calendarEvents.id, ownId), eq(calendarEvents.userId, input.userId))).limit(1);
			if (own) return;
		}
		const id = await inviteEventId(input.userId, invite.uid);
		const where = and(eq(calendarEvents.id, id), eq(calendarEvents.userId, input.userId));
		const [existing] = await db.select().from(calendarEvents).where(where).limit(1);
		// Anyone who learns an invitation UID could otherwise cancel or rewrite the event, so a later message
		// is applied only when it comes from the sender of the message that created the event.
		if (existing && !sameInviteSender(existing, input.senderAddress)) return;
		const plan = planInboundInvite(invite, existing);
		const sender = normalizeInviteSender(input.senderAddress);
		if (plan.action === "ignore") return;
		if (plan.action === "delete") {
			// Nothing remembers the cancellation: a REQUEST for the same UID arriving later (late delivery, or a
			// re-invitation) creates the event again.
			await db.delete(calendarEvents).where(where);
			return;
		}
		if (plan.action === "exclude") {
			if (!existing) return;
			await db.update(calendarEvents).set({ excludedOccurrences: addExcludedOccurrence(existing.excludedOccurrences, plan.occurrence), inviteSender: existing.inviteSender || sender, updatedAt: new Date() }).where(where);
			return;
		}
		const values = { ...inviteEventValues(invite, invite.timeZone ?? userZone, existing?.excludedOccurrences), inviteSender: sender };
		if (plan.action === "insert" || !existing) {
			await db.insert(calendarEvents).values({ id, userId: input.userId, mailboxId: input.mailboxId, color: "#2563eb", responseStatus: "needs-action", inviteMessageId: input.messageId, ...values });
			return;
		}
		const moved = existing.startsAt.getTime() !== invite.startsAt.getTime() || existing.endsAt.getTime() !== invite.endsAt.getTime();
		await db.update(calendarEvents).set({
			...values, inviteMessageId: input.messageId,
			responseStatus: moved ? "needs-action" : existing.responseStatus,
		}).where(where);
	} catch (error) {
		console.error(`Invitation registration failed for ${input.messageId}`, error);
	}
}

const REPLY_STATUS: Record<string, string> = { ACCEPTED: "accepted", TENTATIVE: "tentative", DECLINED: "declined" };

/**
 * A guest's answer to an invitation this user sent. It is recorded only when the sender is a guest on that
 * event, so a stranger who learns the UID cannot mark someone else as accepted. An answer about a single
 * occurrence (RECURRENCE-ID) is not one about the event as a whole, so it is ignored.
 */
async function applyInviteReply(env: CloudflareEnv, userId: string, senderAddress: string, invite: ParsedInvite): Promise<void> {
	if (!invite.uid.endsWith("@mailflare") || invite.recurrenceId) return;
	const db = getDb(env);
	const eventId = invite.uid.slice(0, -"@mailflare".length);
	const [event] = await db.select().from(calendarEvents).where(and(eq(calendarEvents.id, eventId), eq(calendarEvents.userId, userId))).limit(1);
	if (!event) return;
	let guests: string[] = [];
	try { guests = (JSON.parse(event.attendees || "[]") as string[]).map(normalizeInviteSender); } catch { return; }
	const sender = normalizeInviteSender(senderAddress);
	const answer = invite.attendees.find((attendee) => attendee.email === sender && guests.includes(attendee.email));
	const status = answer && REPLY_STATUS[answer.status];
	if (!answer || !status) return;
	let responses: Record<string, string> = {};
	try { responses = JSON.parse(event.attendeeResponses || "{}") as Record<string, string>; } catch { /* start fresh */ }
	responses[answer.email] = status;
	await db.update(calendarEvents).set({ attendeeResponses: JSON.stringify(responses), updatedAt: new Date() }).where(and(eq(calendarEvents.id, eventId), eq(calendarEvents.userId, userId)));
}

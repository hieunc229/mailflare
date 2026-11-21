import { and, desc, eq, isNotNull, isNull } from "drizzle-orm";
import { getDb } from "@/db";
import { calendarEventOverrides, calendarEvents, calendarInviteTombstones, calendarOccurrenceResponses, users } from "@/db/schema";
import { newId } from "@/lib/ids";
import type { AttachmentContent } from "@/lib/email/attachment-types";
import { inviteAttendeeAddresses, inviteRepeat, parseInvite, type ParsedInvite } from "./invite";
import { isIcsAddress } from "./ics";
import { getEmailAddress } from "@/lib/email/address";
import { findInviteAttachment, MAX_INVITE_BYTES } from "./invite-attachment";
import { addExcludedOccurrence, chooseRecipientZone, inboundNeedsRecipientZone, inviteSenderMatches, mergeExcludedOccurrences, normalizeInviteSender, planInboundInvite } from "./invite-rules";

export { findInviteAttachment };

/** One calendar row per (user, invitation UID), so a re-sent or updated invitation edits the same event. */
export async function inviteEventId(userId: string, uid: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${userId}\n${uid}`));
	return `inv_${[...new Uint8Array(digest)].slice(0, 12).map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

/** Latest RSVP per guest per occurrence: the same hash scheme as inviteEventId over event, occurrence and guest. */
export async function occurrenceResponseId(eventId: string, occurrenceMs: number, guest: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${eventId}\n${occurrenceMs}\n${guest}`));
	return `ocr_${[...new Uint8Array(digest)].slice(0, 12).map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

export type EventOverrideInput = { occurrenceMs: number; startsAt: Date; endsAt: Date };

/** Overrides of one series, by (eventId, occurrenceMs): a moved occurrence, or an RDATE extra one. */
export async function listEventOverrides(db: ReturnType<typeof getDb>, eventId: string) {
	return db.select().from(calendarEventOverrides).where(eq(calendarEventOverrides.eventId, eventId));
}

/** Insert an override, or refresh the times of the one already stored for that occurrence. */
export async function upsertEventOverride(db: ReturnType<typeof getDb>, eventId: string, override: EventOverrideInput): Promise<void> {
	const where = and(eq(calendarEventOverrides.eventId, eventId), eq(calendarEventOverrides.occurrenceMs, override.occurrenceMs));
	const [existing] = await db.select({ id: calendarEventOverrides.id }).from(calendarEventOverrides).where(where).limit(1);
	if (existing) {
		await db.update(calendarEventOverrides).set({ startsAt: override.startsAt, endsAt: override.endsAt, updatedAt: new Date() }).where(where);
		return;
	}
	await db.insert(calendarEventOverrides).values({ id: newId("ovr"), eventId, occurrenceMs: override.occurrenceMs, startsAt: override.startsAt, endsAt: override.endsAt, createdAt: new Date(), updatedAt: new Date() });
}

/** Drop the override stored for one occurrence, if any. */
export async function deleteEventOverride(db: ReturnType<typeof getDb>, eventId: string, occurrenceMs: number): Promise<void> {
	await db.delete(calendarEventOverrides).where(and(eq(calendarEventOverrides.eventId, eventId), eq(calendarEventOverrides.occurrenceMs, occurrenceMs)));
}

/** Latest RSVPs on one event the user sent, for the invitation card. */
export async function listOccurrenceResponses(db: ReturnType<typeof getDb>, eventId: string) {
	return db.select().from(calendarOccurrenceResponses).where(eq(calendarOccurrenceResponses.eventId, eventId));
}

/**
 * Extra RDATE instants become overrides, so they survive like exclusions do: only missing ones are added, stored
 * overrides are never removed even when a later revision drops the RDATE.
 */
async function mergeRdateOverrides(db: ReturnType<typeof getDb>, eventId: string, invite: ParsedInvite): Promise<void> {
	if (!invite.rdateDates.length) return;
	const duration = invite.endsAt.getTime() - invite.startsAt.getTime();
	const known = new Set((await listEventOverrides(db, eventId)).map((override) => override.occurrenceMs));
	for (const date of invite.rdateDates) {
		const ms = date.getTime();
		if (known.has(ms)) continue;
		known.add(ms);
		await upsertEventOverride(db, eventId, { occurrenceMs: ms, startsAt: date, endsAt: new Date(ms + duration) });
	}
}

/**
 * Calendar columns written from an invitation. `timeZone` is the zone the event's clock time belongs to (the invitation's
 * own zone, else the recipient's); `existingExcluded` keeps occurrences already excluded when the series is refreshed.
 */
export function inviteEventValues(invite: ParsedInvite, timeZone: string | null, existingExcluded?: string | null) {
	const repeat = inviteRepeat(invite.rrule, invite.startsAt, timeZone);
	return {
		title: invite.title, description: invite.description, location: invite.location,
		// Flat address list only (organizer plus attendees); guest statuses stay on the message card.
		attendees: JSON.stringify(inviteAttendeeAddresses(invite)),
		repeat: repeat.repeat, repeatDays: JSON.stringify(repeat.repeatDays), repeatAnchorDay: repeat.repeatAnchorDay, repeatUntil: repeat.repeatUntil,
		repeatInterval: repeat.repeatInterval, repeatWeekday: repeat.repeatWeekday, repeatWeek: repeat.repeatWeek,
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
		if (!invite) return;
		// A file without METHOD defaults to PUBLISH; treat that as a REQUEST so plain provider invites auto-add.
		// The stored method keeps PUBLISH, so the card and the message GET/POST behavior are unchanged.
		const effectiveMethod = invite.method === "PUBLISH" && invite.methodAbsent ? "REQUEST" : invite.method;
		if (effectiveMethod !== "REQUEST" && effectiveMethod !== "CANCEL" && effectiveMethod !== "REPLY") return;
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
		// A METHOD-less file is easy to spoof, so it auto-adds only when the ORGANIZER proves the sender:
		// a valid calendar address on the sender's own address or domain.
		if (invite.methodAbsent && invite.method === "PUBLISH") {
			const organizerAddress = getEmailAddress(invite.organizer ?? "").trim().toLowerCase();
			const senderAddress = getEmailAddress(input.senderAddress).trim().toLowerCase();
			const domainOf = (address: string) => address.slice(address.indexOf("@") + 1);
			if (!organizerAddress || !isIcsAddress(organizerAddress) || !senderAddress || (organizerAddress !== senderAddress && domainOf(organizerAddress) !== domainOf(senderAddress))) return;
		}
		const id = await inviteEventId(input.userId, invite.uid);
		const where = and(eq(calendarEvents.id, id), eq(calendarEvents.userId, input.userId));
		const [existing] = await db.select().from(calendarEvents).where(where).limit(1);
		// Anyone who learns an invitation UID could otherwise cancel or rewrite the event, so a later message
		// is applied only when it comes from the sender of the message that created the event.
		if (existing && !sameInviteSender(existing, input.senderAddress)) return;
		// A remembered cancellation wins over a late or re-sent revision: only a newer revision from the same
		// sender clears it and proceeds. Anything else is ignored, and an ignored plan never clears it.
		const plan = planInboundInvite({ method: effectiveMethod, recurrenceId: invite.recurrenceId, sequence: invite.sequence }, existing);
		const sender = normalizeInviteSender(input.senderAddress);
		const [tombstone] = await db.select().from(calendarInviteTombstones).where(eq(calendarInviteTombstones.id, id)).limit(1);
		if (tombstone) {
			if (invite.sequence <= tombstone.inviteSequence) return;
			if (sender !== normalizeInviteSender(tombstone.inviteSender)) return;
			if (plan.action === "ignore") {
				// Still a remembered cancellation, just a newer one: keep it and record the newer sequence/sender.
				await db.update(calendarInviteTombstones).set({ inviteSequence: invite.sequence, inviteSender: sender, cancelledAt: new Date() }).where(eq(calendarInviteTombstones.id, id));
				return;
			}
			// Only the paths that actually write clear the tombstone; delete/exclude keep it via their own handling below.
			if (plan.action === "insert" || plan.action === "update" || plan.action === "upsert-override") await db.delete(calendarInviteTombstones).where(eq(calendarInviteTombstones.id, id));
		}
		if (plan.action === "ignore") return;
		if (plan.action === "delete") {
			// The cancellation is remembered, so a late REQUEST for the same UID arriving later (or a
			// re-invitation with an older SEQUENCE) does not recreate the event.
			await db.delete(calendarEvents).where(where);
			const [remembered] = await db.select({ id: calendarInviteTombstones.id }).from(calendarInviteTombstones).where(eq(calendarInviteTombstones.id, id)).limit(1);
			if (remembered) await db.update(calendarInviteTombstones).set({ inviteSequence: invite.sequence, inviteSender: sender, cancelledAt: new Date() }).where(eq(calendarInviteTombstones.id, id));
			else await db.insert(calendarInviteTombstones).values({ id, userId: input.userId, inviteSequence: invite.sequence, inviteSender: sender, cancelledAt: new Date() });
			return;
		}
		if (plan.action === "exclude") {
			if (!existing) return;
			await db.update(calendarEvents).set({ excludedOccurrences: addExcludedOccurrence(existing.excludedOccurrences, plan.occurrence), inviteSender: existing.inviteSender || sender, updatedAt: new Date() }).where(where);
			return;
		}
		if (plan.action === "upsert-override") {
			if (!existing) return;
			await upsertEventOverride(db, id, { occurrenceMs: plan.occurrence.getTime(), startsAt: invite.startsAt, endsAt: invite.endsAt });
			await db.update(calendarEvents).set({ inviteSequence: invite.sequence, inviteMessageId: input.messageId, inviteSender: existing.inviteSender || sender, updatedAt: new Date() }).where(where);
			return;
		}
		const values = { ...inviteEventValues(invite, invite.timeZone ?? userZone, existing?.excludedOccurrences), inviteSender: sender };
		if (plan.action === "insert" || !existing) {
			// The reminder is written once on insert; the event editor stays the only later overwriter.
			await db.insert(calendarEvents).values({ id, userId: input.userId, mailboxId: input.mailboxId, color: "#2563eb", responseStatus: "needs-action", inviteMessageId: input.messageId, ...values, ...(invite.alarmMinutes != null ? { reminderMinutes: invite.alarmMinutes } : {}) });
			await mergeRdateOverrides(db, id, invite);
			return;
		}
		const moved = existing.startsAt.getTime() !== invite.startsAt.getTime() || existing.endsAt.getTime() !== invite.endsAt.getTime();
		await db.update(calendarEvents).set({
			...values, inviteMessageId: input.messageId,
			responseStatus: moved ? "needs-action" : existing.responseStatus,
			// Fill in a reminder only when the row has none; never overwrite the user's own setting.
			...(existing?.reminderMinutes == null && invite.alarmMinutes != null ? { reminderMinutes: invite.alarmMinutes } : {}),
		}).where(where);
		// A refreshed series keeps its per-occurrence edits; new RDATEs join them, dropped ones stay.
		await mergeRdateOverrides(db, id, invite);
	} catch (error) {
		console.error(`Invitation registration failed for ${input.messageId}`, error);
	}
}

const REPLY_STATUS: Record<string, string> = { ACCEPTED: "accepted", TENTATIVE: "tentative", DECLINED: "declined" };

/**
 * A guest's answer to an invitation this user sent. It is recorded only when the sender is a guest on that
 * event, so a stranger who learns the UID cannot mark someone else as accepted. An answer about a single
 * occurrence (RECURRENCE-ID) is stored per occurrence; anything about the event as a whole updates the guest map.
 */
async function applyInviteReply(env: CloudflareEnv, userId: string, senderAddress: string, invite: ParsedInvite): Promise<void> {
	if (!invite.uid.endsWith("@mailflare")) return;
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
	if (invite.recurrenceId) {
		const occurrenceMs = invite.recurrenceId.getTime();
		const rid = await occurrenceResponseId(eventId, occurrenceMs, answer.email);
		const [stored] = await db.select({ id: calendarOccurrenceResponses.id }).from(calendarOccurrenceResponses).where(eq(calendarOccurrenceResponses.id, rid)).limit(1);
		if (stored) await db.update(calendarOccurrenceResponses).set({ status, updatedAt: new Date() }).where(eq(calendarOccurrenceResponses.id, rid));
		else await db.insert(calendarOccurrenceResponses).values({ id: rid, eventId, occurrenceMs, guest: answer.email, status, updatedAt: new Date() });
		return;
	}
	let responses: Record<string, string> = {};
	try { responses = JSON.parse(event.attendeeResponses || "{}") as Record<string, string>; } catch { /* start fresh */ }
	responses[answer.email] = status;
	await db.update(calendarEvents).set({ attendeeResponses: JSON.stringify(responses), updatedAt: new Date() }).where(and(eq(calendarEvents.id, eventId), eq(calendarEvents.userId, userId)));
}

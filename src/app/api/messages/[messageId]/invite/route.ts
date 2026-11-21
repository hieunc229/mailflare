import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { calendarEvents, messages } from "@/db/schema";
import { getCurrentUser } from "@/lib/auth/cookies";
import { authorizeCalendarRequest, calendarKeyCanSendInvitations } from "@/lib/calendar/api-auth";
import type { ApiAuthResult } from "@/lib/api/key-auth-types";
import { getEnv } from "@/lib/cloudflare";
import { buildCounterIcs, buildReplyIcs, buildReplyText, parseCounterProposal, parseInvite, type InviteResponse, type ParsedInvite } from "@/lib/calendar/invite";
import { findInviteAttachment, MAX_INVITE_BYTES } from "@/lib/calendar/invite-attachment";
import { addExcludedOccurrence, normalizeInviteSender, planInviteAnswer } from "@/lib/calendar/invite-rules";
import { inviteEventId, inviteEventValues, recipientInviteTimeZone, sameInviteSender, upsertEventOverride } from "@/lib/calendar/invite-store";
import { hasValidSessionMutationOrigin } from "@/lib/auth/origin";
import { getEmailAddress, splitEmailAddressList } from "@/lib/email/address";
import { getAttachmentForUser, listMessageAttachments } from "@/lib/email/attachments";
import { sendEmail } from "@/lib/email/send";
import { getRequestTimeZone } from "@/lib/time/utils";
import type { InviteRouteParams } from "./types";

type CurrentUser = NonNullable<Awaited<ReturnType<typeof getCurrentUser>>>;

/** `unreadable` means a calendar file exists but could not be read; the routes answer that with a 422, never a 500. */
async function loadInvite(env: CloudflareEnv, user: CurrentUser, messageId: string, timeZone: string | (() => Promise<string>)): Promise<{ invite: ParsedInvite | null; unreadable: boolean }> {
	const attachments = await listMessageAttachments(env, messageId);
	const candidate = findInviteAttachment(attachments);
	if (!candidate || candidate.size > MAX_INVITE_BYTES) return { invite: null, unreadable: false };
	// Only an actual invitation needs the recipient's zone; a quick prefetch for a normal message stops above.
	const [result, zone] = await Promise.all([
		getAttachmentForUser(env, user, messageId, candidate.id),
		typeof timeZone === "function" ? timeZone() : Promise.resolve(timeZone),
	]);
	if (!result) return { invite: null, unreadable: false };
	try {
		const invite = parseInvite(await result.object.text(), { timeZone: zone });
		return { invite, unreadable: !invite };
	} catch (error) {
		console.error(`Invitation in ${messageId} could not be read`, error);
		return { invite: null, unreadable: true };
	}
}

/** The same zone the inbound path uses; the browser's zone only when the account and calendar give none. */
async function inviteZone(db: ReturnType<typeof getDb>, request: Request, user: CurrentUser): Promise<string> {
	return (await recipientInviteTimeZone(db, user.id)) ?? getRequestTimeZone(request, user.timeZone);
}

const UNREADABLE = { error: "This invitation could not be read" };

/**
 * Who is answering: the dashboard session, or an API key with the calendar scope (read to look, write to
 * answer) that may also read the message's mailbox. A key needs the `send` scope for that mailbox before the
 * reply goes out, as for invitations the calendar API sends.
 */
async function inviteCaller(env: CloudflareEnv, request: Request, messageId: string, scope: "calendar:read" | "calendar:write"):
	Promise<{ user: CurrentUser; key: ApiAuthResult | null; error: null } | { user: null; key: null; error: NextResponse }> {
	const authorization = request.headers.get("Authorization") ?? "";
	if (!authorization.startsWith("Bearer ep_") && !authorization.startsWith("Basic ")) {
		const user = await getCurrentUser(env, request);
		return user ? { user, key: null, error: null } : { user: null, key: null, error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
	}
	const { user, key, error } = await authorizeCalendarRequest(env, request, scope);
	if (error || !user || !key) return { user: null, key: null, error: error ?? NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
	const [row] = await getDb(env).select({ mailboxId: messages.mailboxId }).from(messages).where(eq(messages.id, messageId)).limit(1);
	if (!row?.mailboxId || (key.mailboxIds !== null && !key.mailboxIds.includes(row.mailboxId))) {
		return { user: null, key: null, error: NextResponse.json({ error: "Message not found" }, { status: 404 }) };
	}
	return { user: user as CurrentUser, key, error: null };
}

export async function GET(request: Request, { params }: InviteRouteParams) {
	const env = getEnv();
	const { messageId } = await params;
	const { user, error } = await inviteCaller(env, request, messageId, "calendar:read");
	if (error) return error;
	const db = getDb(env);
	const { invite, unreadable } = await loadInvite(env, user, messageId, () => inviteZone(db, request, user));
	if (unreadable) return NextResponse.json({ invite: null, ...UNREADABLE }, { status: 422 });
	if (!invite) return NextResponse.json({ invite: null });
	const id = await inviteEventId(user.id, invite.uid);
	const [existing] = await db.select({ id: calendarEvents.id, responseStatus: calendarEvents.responseStatus, updatedAt: calendarEvents.updatedAt }).from(calendarEvents).where(and(eq(calendarEvents.id, id), eq(calendarEvents.userId, user.id))).limit(1);
	// The answer is kept on the message so it survives a decline, which removes the event from the calendar.
	const [stored] = await db.select({ inviteResponse: messages.inviteResponse }).from(messages).where(eq(messages.id, messageId)).limit(1);
	const saved = stored?.inviteResponse ?? existing?.responseStatus ?? null;
	const response = saved === "accepted" || saved === "tentative" || saved === "declined" ? saved : null;
	// The message row carries no answer timestamp, so the receipt time is the event's update; a decline
	// removes the event and reports null, and the card falls back to its own timestamp then.
	return NextResponse.json({ invite, eventId: existing?.id ?? null, response, canRespond: invite.method === "REQUEST" || invite.method === "PUBLISH", answeredAt: existing?.updatedAt ? new Date(existing.updatedAt).toISOString() : null });
}

export async function POST(request: Request, { params }: InviteRouteParams) {
	const env = getEnv();
	const { messageId } = await params;
	const { user, key, error } = await inviteCaller(env, request, messageId, "calendar:write");
	if (error) return error;
	if (!key && !hasValidSessionMutationOrigin(request)) return NextResponse.json({ error: "Invalid origin" }, { status: 403 });
	const body = await request.json().catch(() => ({})) as { response?: InviteResponse; sendReply?: boolean; note?: string; action?: string; startsAt?: string; endsAt?: string; rsvp?: InviteResponse };
	const isCounter = body.action === "counter";
	let response: InviteResponse;
	let proposal: { startsAt: Date; endsAt: Date } | null = null;
	if (isCounter) {
		proposal = parseCounterProposal(body.startsAt, body.endsAt);
		if (!proposal) return NextResponse.json({ error: "Choose a valid proposed start and end" }, { status: 400 });
		response = body.rsvp ?? "tentative";
		if (response !== "accepted" && response !== "tentative" && response !== "declined") return NextResponse.json({ error: "Choose accept, maybe or decline" }, { status: 400 });
	} else {
		const legacy = body.response;
		if (legacy !== "accepted" && legacy !== "tentative" && legacy !== "declined") return NextResponse.json({ error: "Choose accept, maybe or decline" }, { status: 400 });
		response = legacy;
	}
	if (body.note !== undefined && typeof body.note !== "string") return NextResponse.json({ error: "Note must be a string" }, { status: 400 });
	const sendReply = body.sendReply !== false;
	const db = getDb(env);
	// Stored on the event below, so the next inbound update of an all-day or floating invitation finds the same zone.
	const userZone = await inviteZone(db, request, user);
	const { invite, unreadable } = await loadInvite(env, user, messageId, userZone);
	if (unreadable) return NextResponse.json(UNREADABLE, { status: 422 });
	if (!invite) return NextResponse.json({ error: "This message has no readable invitation" }, { status: 404 });
	if (isCounter && invite.method !== "REQUEST") return NextResponse.json({ error: "A new time can only be proposed for an invitation request" }, { status: 400 });
	if (!isCounter && invite.method !== "REQUEST" && invite.method !== "CANCEL" && invite.method !== "PUBLISH") return NextResponse.json({ error: "This message is a reply, not an invitation" }, { status: 400 });
	const [message] = await db.select().from(messages).where(eq(messages.id, messageId)).limit(1);
	if (!message) return NextResponse.json({ error: "Message not found" }, { status: 404 });

	const id = await inviteEventId(user.id, invite.uid);
	const where = and(eq(calendarEvents.id, id), eq(calendarEvents.userId, user.id));
	const [existing] = await db.select().from(calendarEvents).where(where).limit(1);
	const sender = normalizeInviteSender(message.fromAddr);
	// An event already on the calendar can only be changed by a message from whoever created it.
	if (existing && !sameInviteSender(existing, sender)) return NextResponse.json({ error: "This invitation does not come from the sender of the existing event" }, { status: 409 });
	const plan = planInviteAnswer(invite, response, existing);
	let eventId: string | null = null;
	if (plan.action === "delete") {
		await db.delete(calendarEvents).where(where);
	} else if (plan.action === "exclude" && existing) {
		await db.update(calendarEvents).set({ excludedOccurrences: addExcludedOccurrence(existing.excludedOccurrences, plan.occurrence), inviteSender: existing.inviteSender || sender, updatedAt: new Date() }).where(where);
		eventId = existing.id;
	} else if (plan.action === "none") {
		eventId = existing?.id ?? null;
	} else if (plan.action === "status" && existing) {
		// The calendar already holds a newer revision of this invitation; record the answer without reverting it.
		await db.update(calendarEvents).set({ responseStatus: response, inviteSender: existing.inviteSender || sender, timeZone: existing.timeZone ?? userZone, updatedAt: new Date() }).where(where);
		eventId = existing.id;
	} else if (plan.action === "upsert-override" && existing) {
		// Answering one occurrence of a series edits only that occurrence; the series row keeps its times and
		// revision. Never touches tombstones: those live only in the automatic inbound path.
		await upsertEventOverride(db, existing.id, { occurrenceMs: plan.occurrence.getTime(), startsAt: invite.startsAt, endsAt: invite.endsAt });
		await db.update(calendarEvents).set({ inviteSender: existing.inviteSender || sender, timeZone: existing.timeZone ?? userZone, updatedAt: new Date() }).where(where);
		eventId = existing.id;
	} else {
		const values = {
			...inviteEventValues(invite, invite.timeZone ?? userZone, existing?.excludedOccurrences),
			responseStatus: response, inviteMessageId: messageId, inviteSender: sender,
		};
		// The colour is chosen only when the row is created, so one the user changed is kept.
		// The reminder is written once on insert, and on update only when the row has none.
		const insertValues = invite.alarmMinutes != null ? { ...values, reminderMinutes: invite.alarmMinutes } : values;
		const updateValues = existing?.reminderMinutes == null ? insertValues : values;
		await db.insert(calendarEvents).values({ id, userId: user.id, mailboxId: message.mailboxId, color: response === "tentative" ? "#7c3aed" : "#2563eb", ...insertValues }).onConflictDoUpdate({ target: calendarEvents.id, set: updateValues });
		eventId = id;
	}

	await db.update(messages).set({ inviteResponse: response }).where(eq(messages.id, messageId));

	let replySent = false;
	// ORGANIZER is written by the sender, so it is trusted only when it is on the sender's own domain
	// (a calendar service replying for its user, or a colleague). Otherwise the reply goes to the sender.
	const SINGLE_ADDRESS = /^[^\s@<>",;()\\]+@[^\s@<>",;()\\]+$/;
	const replySender = getEmailAddress(message.replyTo || message.fromAddr).trim().toLowerCase();
	const organizer = invite.organizer?.trim().toLowerCase() ?? "";
	const domainOf = (address: string) => address.slice(address.indexOf("@") + 1);
	const replyTo = SINGLE_ADDRESS.test(organizer) && SINGLE_ADDRESS.test(replySender) && domainOf(organizer) === domainOf(replySender) ? organizer : replySender;
	if (!SINGLE_ADDRESS.test(replyTo)) return NextResponse.json({ ok: true, eventId, replySent: false });
	if (sendReply && invite.method === "REQUEST" && message.mailboxId && replyTo && calendarKeyCanSendInvitations(key, message.mailboxId)) {
		const candidates = [...splitEmailAddressList(message.toAddr), ...splitEmailAddressList(message.ccAddr ?? "")].map(getEmailAddress).filter(Boolean);
		if (isCounter && !proposal) return NextResponse.json({ error: "Choose a valid proposed start and end" }, { status: 400 });
		const counterProposal = isCounter ? proposal : null;
		const verb = counterProposal ? "New time proposed" : { accepted: "Accepted", tentative: "Tentatively accepted", declined: "Declined" }[response];
		const subject = `${verb}: ${invite.title}`.replace(/\s+/g, " ").trim();
		let lastError: unknown = null;
		for (const from of candidates) {
			try {
				const text = counterProposal
					? `${buildReplyText(from, "proposed a new time for", invite.title, body.note)}\n\nProposed time: ${counterProposal.startsAt.toISOString()} - ${counterProposal.endsAt.toISOString()}`
					: buildReplyText(from, verb.toLowerCase(), invite.title, body.note);
				const ics = counterProposal
					? buildCounterIcs(invite, from, counterProposal, typeof body.note === "string" && body.note.trim() ? { message: body.note } : undefined)
					: buildReplyIcs(invite, from, response);
				await sendEmail(env, {
					userId: user.id, mailboxId: message.mailboxId, from, to: [replyTo],
					subject, text,
					inReplyTo: message.providerMessageId, threadId: message.threadId,
					attachments: [{ filename: counterProposal ? "counter.ics" : "reply.ics", type: `text/calendar; method=${counterProposal ? "COUNTER" : "REPLY"}; charset=utf-8`, content: new TextEncoder().encode(ics).buffer as ArrayBuffer }],
				});
				replySent = true;
				break;
			} catch (error) {
				// This address may not be one the user can send from; try the next recipient address.
				lastError = error;
			}
		}
		if (!replySent && candidates.length) console.error(`Invitation reply for ${messageId} failed from every recipient address`, lastError);
	}
	return NextResponse.json({ ok: true, eventId, replySent });
}

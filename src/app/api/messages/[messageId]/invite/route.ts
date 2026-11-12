import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { calendarEvents, messages } from "@/db/schema";
import { getCurrentUser } from "@/lib/auth/cookies";
import { getEnv } from "@/lib/cloudflare";
import { buildReplyIcs, parseInvite, type InviteResponse, type ParsedInvite } from "@/lib/calendar/invite";
import { findInviteAttachment, MAX_INVITE_BYTES } from "@/lib/calendar/invite-attachment";
import { addExcludedOccurrence, normalizeInviteSender, planInviteAnswer } from "@/lib/calendar/invite-rules";
import { inviteEventId, inviteEventValues, recipientInviteTimeZone, sameInviteSender } from "@/lib/calendar/invite-store";
import { hasValidSessionMutationOrigin } from "@/lib/auth/origin";
import { getEmailAddress, splitEmailAddressList } from "@/lib/email/address";
import { getAttachmentForUser, listMessageAttachments } from "@/lib/email/attachments";
import { sendEmail } from "@/lib/email/send";
import { getRequestTimeZone } from "@/lib/time/utils";
import type { InviteRouteParams } from "./types";

type CurrentUser = NonNullable<Awaited<ReturnType<typeof getCurrentUser>>>;

/** `unreadable` means a calendar file exists but could not be read; the routes answer that with a 422, never a 500. */
async function loadInvite(env: CloudflareEnv, user: CurrentUser, messageId: string, timeZone: string): Promise<{ invite: ParsedInvite | null; unreadable: boolean }> {
	const attachments = await listMessageAttachments(env, messageId);
	const candidate = findInviteAttachment(attachments);
	if (!candidate || candidate.size > MAX_INVITE_BYTES) return { invite: null, unreadable: false };
	const result = await getAttachmentForUser(env, user, messageId, candidate.id);
	if (!result) return { invite: null, unreadable: false };
	try {
		const invite = parseInvite(await result.object.text(), { timeZone });
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

export async function GET(request: Request, { params }: InviteRouteParams) {
	const env = getEnv();
	const user = await getCurrentUser(env, request);
	if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
	const { messageId } = await params;
	const { invite, unreadable } = await loadInvite(env, user, messageId, await inviteZone(getDb(env), request, user));
	if (unreadable) return NextResponse.json({ invite: null, ...UNREADABLE }, { status: 422 });
	if (!invite) return NextResponse.json({ invite: null });
	const id = await inviteEventId(user.id, invite.uid);
	const [existing] = await getDb(env).select({ id: calendarEvents.id }).from(calendarEvents).where(and(eq(calendarEvents.id, id), eq(calendarEvents.userId, user.id))).limit(1);
	return NextResponse.json({ invite, eventId: existing?.id ?? null, canRespond: invite.method === "REQUEST" || invite.method === "PUBLISH" });
}

export async function POST(request: Request, { params }: InviteRouteParams) {
	const env = getEnv();
	const user = await getCurrentUser(env, request);
	if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
	if (!hasValidSessionMutationOrigin(request)) return NextResponse.json({ error: "Invalid origin" }, { status: 403 });
	const { messageId } = await params;
	const body = await request.json().catch(() => ({})) as { response?: InviteResponse; sendReply?: boolean };
	const response = body.response;
	if (response !== "accepted" && response !== "tentative" && response !== "declined") return NextResponse.json({ error: "Choose accept, maybe or decline" }, { status: 400 });
	const db = getDb(env);
	// Stored on the event below, so the next inbound update of an all-day or floating invitation finds the same zone.
	const userZone = await inviteZone(db, request, user);
	const { invite, unreadable } = await loadInvite(env, user, messageId, userZone);
	if (unreadable) return NextResponse.json(UNREADABLE, { status: 422 });
	if (!invite) return NextResponse.json({ error: "This message has no readable invitation" }, { status: 404 });
	if (invite.method !== "REQUEST" && invite.method !== "CANCEL" && invite.method !== "PUBLISH") return NextResponse.json({ error: "This message is a reply, not an invitation" }, { status: 400 });
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
	} else {
		const values = {
			...inviteEventValues(invite, invite.timeZone ?? userZone, existing?.excludedOccurrences),
			responseStatus: response, inviteMessageId: messageId, inviteSender: sender,
		};
		// The colour is chosen only when the row is created, so one the user changed is kept.
		await db.insert(calendarEvents).values({ id, userId: user.id, mailboxId: message.mailboxId, color: response === "tentative" ? "#7c3aed" : "#2563eb", ...values }).onConflictDoUpdate({ target: calendarEvents.id, set: values });
		eventId = id;
	}

	let replySent = false;
	// ORGANIZER is written by the sender, so it is trusted only when it is on the sender's own domain
	// (a calendar service replying for its user, or a colleague). Otherwise the reply goes to the sender.
	const SINGLE_ADDRESS = /^[^\s@<>",;()\\]+@[^\s@<>",;()\\]+$/;
	const replySender = getEmailAddress(message.replyTo || message.fromAddr).trim().toLowerCase();
	const organizer = invite.organizer?.trim().toLowerCase() ?? "";
	const domainOf = (address: string) => address.slice(address.indexOf("@") + 1);
	const replyTo = SINGLE_ADDRESS.test(organizer) && SINGLE_ADDRESS.test(replySender) && domainOf(organizer) === domainOf(replySender) ? organizer : replySender;
	if (!SINGLE_ADDRESS.test(replyTo)) return NextResponse.json({ ok: true, eventId, replySent: false });
	if (body.sendReply !== false && invite.method === "REQUEST" && message.mailboxId && replyTo) {
		const candidates = [...splitEmailAddressList(message.toAddr), ...splitEmailAddressList(message.ccAddr ?? "")].map(getEmailAddress).filter(Boolean);
		const verb = { accepted: "Accepted", tentative: "Tentatively accepted", declined: "Declined" }[response];
		const subject = `${verb}: ${invite.title}`.replace(/\s+/g, " ").trim();
		let lastError: unknown = null;
		for (const from of candidates) {
			try {
				await sendEmail(env, {
					userId: user.id, mailboxId: message.mailboxId, from, to: [replyTo],
					subject, text: `${from} ${verb.toLowerCase()}: ${invite.title}`,
					inReplyTo: message.providerMessageId, threadId: message.threadId,
					attachments: [{ filename: "reply.ics", type: "text/calendar; method=REPLY; charset=utf-8", content: new TextEncoder().encode(buildReplyIcs(invite, from, response)).buffer as ArrayBuffer }],
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

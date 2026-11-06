import { and, eq, isNull, ne, sql } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { domains, mailboxes, messages } from "@/db/schema";
import { getCurrentUser } from "@/lib/auth/cookies";
import { getEnv } from "@/lib/cloudflare";
import { getEmailAddress } from "@/lib/email/address";
import { getOutboundProviderConfig, sendThroughProvider } from "@/lib/email/outbound-provider";
import { extractUnsubscribeLinkFromBody, getUnsubscribeUrlFromRawR2Key, parseMailtoUnsubscribe } from "@/lib/email/unsubscribe";
import { createAuditLog } from "@/lib/mailboxes/audit";
import { getMailboxAccessLevel } from "@/lib/mailboxes/access";
import { escapeLike, insensitiveLike } from "@/db/sql";
import type { MailtoUnsubscribeTarget, UnsubscribePayload, UnsubscribeRouteParams } from "./types";
import { allowUnsubscribeRequest, postOneClickUnsubscribe } from "./utils";

const TRASH_SWEEP_LIMIT = 5_000;

/**
 * Sends the mailto: unsubscribe straight through the outbound provider so it
 * leaves from the mailbox that received the list mail but never lands in Sent
 * (or contacts). Returns false when the mailbox cannot send, so the caller can
 * hand the mailto back to the client instead.
 */
async function sendUnsubscribeEmail(env: CloudflareEnv, mailboxId: string, target: MailtoUnsubscribeTarget): Promise<boolean> {
	const db = getDb(env);
	const [mailbox] = await db
		.select({ localPart: mailboxes.localPart, hostname: domains.hostname })
		.from(mailboxes)
		.innerJoin(domains, eq(mailboxes.domainId, domains.id))
		.where(eq(mailboxes.id, mailboxId))
		.limit(1);
	if (!mailbox) return false;
	try {
		const from = `${mailbox.localPart}@${mailbox.hostname}`;
		const provider = await getOutboundProviderConfig(env, from);
		await sendThroughProvider(env, provider, { from, to: [target.to], subject: target.subject, text: target.text });
		return true;
	} catch {
		return false;
	}
}

/** Past messages from the same sender that a sweep would move to Trash. Starred mail and mail filed by the user stay put. */
function senderTrashCondition(mailboxId: string, senderAddress: string) {
	return and(
		eq(messages.mailboxId, mailboxId),
		insensitiveLike(messages.fromAddr, `%${escapeLike(senderAddress)}%`),
		eq(messages.starred, false),
		isNull(messages.folderId),
		ne(messages.status, "trash"),
	);
}

/**
 * Acts on the message's own List-Unsubscribe data, re-derived from the stored
 * raw MIME — never a client-supplied URL. One-click (RFC 8058) posts server-side
 * only when a DKIM signature covers the header, the URL is a public https host
 * and redirects are left unfollowed; a bare https link comes back for the
 * client to open, a mailto is sent through the outbound pipeline, and a
 * body-found link is only ever returned as "link". With action
 * "unsubscribe_and_trash" the sender's past mail moves to Trash as well
 * (starred and filed mail kept; requires manage access).
 */
export async function POST(request: Request, { params }: UnsubscribeRouteParams) {
	const { messageId } = await params;
	const env = getEnv();
	const user = await getCurrentUser(env, request);
	if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
	if (!allowUnsubscribeRequest(user.id)) {
		return NextResponse.json({ error: "Too many unsubscribe attempts" }, { status: 429 });
	}

	const payload = (await request.json().catch(() => ({}))) as UnsubscribePayload;
	const andTrash = payload.action === "unsubscribe_and_trash";
	const previewOnly = payload.previewOnly === true;

	const db = getDb(env);
	const [message] = await db
		.select({
			id: messages.id,
			mailboxId: messages.mailboxId,
			rawR2Key: messages.rawR2Key,
			htmlBody: messages.htmlBody,
			textBody: messages.textBody,
			fromAddr: messages.fromAddr,
			status: messages.status,
		})
		.from(messages)
		.where(eq(messages.id, messageId))
		.limit(1);
	if (!message?.mailboxId) return NextResponse.json({ error: "Message not found" }, { status: 404 });

	const access = await getMailboxAccessLevel(db, user, message.mailboxId);
	if (!access?.canRead) return NextResponse.json({ error: "Message not found" }, { status: 404 });
	if ((andTrash || previewOnly) && !access.canManage) {
		return NextResponse.json({ error: "Message not found" }, { status: 404 });
	}
	// Unsubscribing confirms the address is live; spam gets blocked/reported, never unsubscribed.
	if (message.status === "spam") {
		return NextResponse.json({ error: "This message can't be unsubscribed" }, { status: 409 });
	}

	const senderAddress = getEmailAddress(message.fromAddr).trim().toLowerCase();
	let trashedCount: number | undefined;
	if ((andTrash || previewOnly) && senderAddress) {
		const where = senderTrashCondition(message.mailboxId, senderAddress);
		const [row] = await db.select({ count: sql<number>`count(*)` }).from(messages).where(where);
		const count = Math.min(Number(row?.count ?? 0), TRASH_SWEEP_LIMIT);
		if (previewOnly) return NextResponse.json({ ok: true, preview: { sender: senderAddress, count } });

		await createAuditLog(env, {
			actorUserId: user.id,
			mailboxId: message.mailboxId,
			action: "email.unsubscribe_and_trash",
			metadata: { sender: senderAddress, count },
		});
		await db.update(messages).set({ status: "trash" }).where(where);
		trashedCount = count;
	}

	const candidate = await getUnsubscribeUrlFromRawR2Key(env, message.rawR2Key);
	const url = candidate?.url ?? null;

	// Gmail's order: RFC 8058 one-click POST, then an unsubscribe email, then
	// the sender's page for the person to finish.
	if (url?.startsWith("https://") && candidate?.oneClick && candidate.dkimCoversUnsubscribe && (await postOneClickUnsubscribe(url))) {
		return NextResponse.json({ ok: true, method: "one-click", trashedCount });
	}

	const mailtoUrl = candidate?.mailto ?? null;
	if (mailtoUrl) {
		const target = parseMailtoUnsubscribe(mailtoUrl);
		const canSend = access.canSendAs || access.canSendOnBehalf || access.canManage;
		if (target && canSend && (await sendUnsubscribeEmail(env, message.mailboxId, target))) {
			return NextResponse.json({ ok: true, method: "mailto", trashedCount });
		}
	}

	if (url) return NextResponse.json({ ok: true, method: "link", url, trashedCount });

	const bodyLink = extractUnsubscribeLinkFromBody(message.htmlBody, message.textBody);
	if (bodyLink) return NextResponse.json({ ok: true, method: "link", url: bodyLink, trashedCount });
	return NextResponse.json({ error: "This message does not offer a way to unsubscribe" }, { status: 404 });
}

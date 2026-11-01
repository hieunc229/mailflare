import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { domains, mailboxes, messages } from "@/db/schema";
import { getCurrentUser } from "@/lib/auth/cookies";
import { getEnv } from "@/lib/cloudflare";
import { getMailboxAccessLevel } from "@/lib/mailboxes/access";
import { sendEmail } from "@/lib/email/send";
import { extractUnsubscribeLinkFromBody, getUnsubscribeUrlFromRawR2Key } from "@/lib/email/unsubscribe";
import type { MailtoUnsubscribeTarget, UnsubscribeRouteParams } from "./types";
import { parseMailtoUnsubscribe, postOneClickUnsubscribe } from "./utils";

/**
 * Sends the mailto: unsubscribe through the normal outbound pipeline so the
 * request leaves from the mailbox that received the list mail. Returns false
 * when the mailbox cannot send (no provider, read-only share): the caller then
 * hands the mailto back to the client.
 */
async function sendUnsubscribeEmail(env: CloudflareEnv, userId: string, mailboxId: string, target: MailtoUnsubscribeTarget): Promise<boolean> {
	const db = getDb(env);
	const [mailbox] = await db
		.select({ localPart: mailboxes.localPart, hostname: domains.hostname })
		.from(mailboxes)
		.innerJoin(domains, eq(mailboxes.domainId, domains.id))
		.where(eq(mailboxes.id, mailboxId))
		.limit(1);
	if (!mailbox) return false;
	try {
		await sendEmail(env, {
			userId,
			from: `${mailbox.localPart}@${mailbox.hostname}`,
			to: target.to,
			subject: target.subject,
			text: target.text,
			mailboxId,
		});
		return true;
	} catch {
		return false;
	}
}

/**
 * Acts on the message's own List-Unsubscribe data, re-derived from the stored
 * raw MIME — never a client-supplied URL. One-click (RFC 8058) posts server-side,
 * a bare https link comes back for the client to open, a mailto is sent through
 * the outbound pipeline, and a body-found link is only ever returned as "link".
 */
export async function POST(request: Request, { params }: UnsubscribeRouteParams) {
	const { messageId } = await params;
	const env = getEnv();
	const user = await getCurrentUser(env, request);
	if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

	const db = getDb(env);
	const [message] = await db
		.select({ id: messages.id, mailboxId: messages.mailboxId, rawR2Key: messages.rawR2Key, htmlBody: messages.htmlBody, textBody: messages.textBody })
		.from(messages)
		.where(eq(messages.id, messageId))
		.limit(1);
	if (!message?.mailboxId) return NextResponse.json({ error: "Message not found" }, { status: 404 });

	const access = await getMailboxAccessLevel(db, user, message.mailboxId);
	if (!access?.canRead) return NextResponse.json({ error: "Message not found" }, { status: 404 });

	const candidate = await getUnsubscribeUrlFromRawR2Key(env, message.rawR2Key);
	const url = candidate?.url ?? null;

	if (url?.startsWith("mailto:")) {
		const target = parseMailtoUnsubscribe(url);
		if (target && (await sendUnsubscribeEmail(env, user.id, message.mailboxId, target))) {
			return NextResponse.json({ ok: true, method: "mailto" });
		}
		return NextResponse.json({ ok: true, method: "link", url });
	}

	if (url && url.startsWith("https://")) {
		// A failed one-click still leaves the link as the way out.
		if (candidate?.oneClick && (await postOneClickUnsubscribe(url))) {
			return NextResponse.json({ ok: true, method: "one-click" });
		}
		return NextResponse.json({ ok: true, method: "link", url });
	}

	if (url) return NextResponse.json({ ok: true, method: "link", url });

	const bodyLink = extractUnsubscribeLinkFromBody(message.htmlBody, message.textBody);
	if (bodyLink) return NextResponse.json({ ok: true, method: "link", url: bodyLink });
	return NextResponse.json({ error: "This message does not offer a way to unsubscribe" }, { status: 404 });
}

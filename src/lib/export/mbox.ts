import { and, asc, eq, gt, or } from "drizzle-orm";
import { getDb } from "@/db";
import { messages } from "@/db/schema";
import { draftsVisibleTo } from "@/lib/email/draft-access";

function escapeHeader(value: string | null): string {
	return (value ?? "").replace(/\r?\n/g, " ").trim();
}

function escapeMboxBody(value: string): string {
	// mboxrd: quote ">*From " lines so a reader can strip exactly one ">" back off.
	// The body follows a blank line, so its first line would start a new message too.
	return value.replace(/(^|\n)(>*From )/g, "$1>$2");
}

function getMboxFromLine(date: Date): string {
	return `From MAILER-DAEMON ${date.toUTCString()}`;
}

const PAGE_SIZE = 200;

type MboxMessage = {
	id: string;
	fromAddr: string | null;
	toAddr: string | null;
	ccAddr: string | null;
	inReplyTo: string | null;
	references: string | null;
	subject: string | null;
	providerMessageId: string | null;
	direction: string | null;
	status: string | null;
	createdAt: Date;
	textBody: string | null;
	htmlBody: string | null;
};

function formatMboxMessage(message: MboxMessage): string {
	const date = new Date(message.createdAt);
	const body = message.htmlBody ?? message.textBody ?? "";
	const contentType = message.htmlBody ? "text/html" : "text/plain";
	return [
		getMboxFromLine(date),
		`Message-ID: ${escapeHeader(message.providerMessageId || `<${message.id}@mailflare.local>`)}`,
		`Date: ${date.toUTCString()}`,
		`From: ${escapeHeader(message.fromAddr)}`,
		`To: ${escapeHeader(message.toAddr)}`,
		...(message.ccAddr ? [`Cc: ${escapeHeader(message.ccAddr)}`] : []),
		...(message.inReplyTo ? [`In-Reply-To: <${escapeHeader(message.inReplyTo)}>`] : []),
		...(message.references
			? [`References: ${message.references.split(/\s+/).filter(Boolean).map((id) => `<${id}>`).join(" ")}`]
			: []),
		`Subject: ${escapeHeader(message.subject)}`,
		`X-Mailflare-Direction: ${escapeHeader(message.direction)}`,
		`X-Mailflare-Status: ${escapeHeader(message.status)}`,
		"MIME-Version: 1.0",
		`Content-Type: ${contentType}; charset=utf-8`,
		"Content-Transfer-Encoding: 8bit",
		"",
		escapeMboxBody(body),
		"",
	].join("\r\n");
}

/**
 * `userId` is the exporting user: other users' drafts in a shared mailbox are left out.
 * Reads the mailbox 200 messages at a time, only as the consumer pulls, ordered by (created_at, id).
 */
export function exportMailboxToMboxStream(env: CloudflareEnv, mailboxId: string, userId: string): ReadableStream<Uint8Array> {
	const db = getDb(env);
	const encoder = new TextEncoder();
	let cursor: { createdAt: Date; id: string } | null = null;
	let first = true;
	return new ReadableStream<Uint8Array>({
		async pull(controller) {
			const page = await db
				.select({
					id: messages.id,
					fromAddr: messages.fromAddr,
					toAddr: messages.toAddr,
					ccAddr: messages.ccAddr,
					inReplyTo: messages.inReplyTo,
					references: messages.references,
					subject: messages.subject,
					providerMessageId: messages.providerMessageId,
					direction: messages.direction,
					status: messages.status,
					createdAt: messages.createdAt,
					textBody: messages.textBody,
					htmlBody: messages.htmlBody,
				})
				.from(messages)
				.where(and(
					eq(messages.mailboxId, mailboxId),
					draftsVisibleTo(userId),
					cursor ? or(gt(messages.createdAt, cursor.createdAt), and(eq(messages.createdAt, cursor.createdAt), gt(messages.id, cursor.id))) : undefined,
				))
				.orderBy(asc(messages.createdAt), asc(messages.id))
				.limit(PAGE_SIZE);
			if (page.length > 0) {
				controller.enqueue(encoder.encode((first ? "" : "\r\n") + page.map(formatMboxMessage).join("\r\n")));
				first = false;
				const last = page[page.length - 1];
				cursor = { createdAt: last.createdAt, id: last.id };
			}
			if (page.length < PAGE_SIZE) controller.close();
		},
	}, { highWaterMark: 0 });
}

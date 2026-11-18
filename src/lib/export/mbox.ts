import { asc, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { messages } from "@/db/schema";

function escapeHeader(value: string | null): string {
	return (value ?? "").replace(/\r?\n/g, " ").trim();
}

function escapeMboxBody(value: string): string {
	// The body follows a blank line, so its first line would start a new message too.
	return value.replace(/(^|\n)From /g, "$1>From ");
}

function getMboxFromLine(date: Date): string {
	return `From MAILER-DAEMON ${date.toUTCString()}`;
}

export async function exportMailboxToMbox(env: CloudflareEnv, mailboxId: string): Promise<string> {
	const db = getDb(env);
	const rows = await db
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
		.where(eq(messages.mailboxId, mailboxId))
		.orderBy(asc(messages.createdAt));

	return rows.map((message) => {
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
	}).join("\r\n");
}

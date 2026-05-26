import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { messageBodies, messages } from "@/db/schema";
import { newId } from "@/lib/ids";
import { buildSnippet, parseRawMime } from "@/lib/email/parse";
import { resolveInboundAddress } from "@/lib/email/routing";
import { dispatchWebhooks } from "@/lib/email/webhooks";

export type InboundQueueMessage = {
	from: string;
	to: string;
	rawR2Key: string;
	headers?: Record<string, string>;
};

export async function processInboundMessage(
	env: CloudflareEnv,
	payload: InboundQueueMessage,
): Promise<void> {
	const db = getDb(env);
	const decision = await resolveInboundAddress(db, payload.to);

	if (!decision) {
		console.warn(`No routing for inbound address: ${payload.to}`);
		return;
	}

	if (decision.action === "reject") {
		console.warn(`Rejected inbound: ${payload.to}`);
		return;
	}

	if (decision.action === "forward" && decision.forwardTo) {
		console.info(`Forward ${payload.to} -> ${decision.forwardTo}`);
		return;
	}

	if (!decision.mailbox) return;

	const raw = await env.BUCKET.get(payload.rawR2Key);
	if (!raw) {
		console.error(`Missing R2 object: ${payload.rawR2Key}`);
		return;
	}

	const buffer = await raw.arrayBuffer();
	const parsed = await parseRawMime(buffer);
	const messageId = newId("msg");
	const snippet = buildSnippet(parsed.text, parsed.html);

	await db.insert(messages).values({
		id: messageId,
		userId: decision.mailbox.userId,
		mailboxId: decision.mailbox.mailboxId,
		direction: "inbound",
		providerMessageId: parsed.messageId,
		fromAddr: payload.from,
		toAddr: payload.to,
		subject: parsed.subject,
		snippet,
		status: "received",
		threadId: parsed.messageId,
	});

	await db.insert(messageBodies).values({
		id: newId(),
		messageId,
		textBody: parsed.text,
		htmlBody: parsed.html,
		rawR2Key: payload.rawR2Key,
	});

	await dispatchWebhooks(env, decision.mailbox.userId, "message.inbound", {
		messageId,
		from: payload.from,
		to: payload.to,
		subject: parsed.subject,
	});
}

export async function storeRawToR2(
	env: CloudflareEnv,
	from: string,
	to: string,
	raw: ReadableStream<Uint8Array>,
): Promise<string> {
	const key = `inbound/${Date.now()}-${newId()}.eml`;
	const buffer = await new Response(raw).arrayBuffer();
	await env.BUCKET.put(key, buffer, {
		httpMetadata: { contentType: "message/rfc822" },
		customMetadata: { from, to },
	});
	return key;
}

export async function getMessageWithBody(env: CloudflareEnv, userId: string, messageId: string) {
	const db = getDb(env);
	const [message] = await db
		.select()
		.from(messages)
		.where(eq(messages.id, messageId))
		.limit(1);
	if (!message || message.userId !== userId) return null;
	const [body] = await db
		.select()
		.from(messageBodies)
		.where(eq(messageBodies.messageId, messageId))
		.limit(1);
	return { message, body };
}

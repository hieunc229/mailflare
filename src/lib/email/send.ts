import { eq, and } from "drizzle-orm";
import { getDb } from "@/db";
import { domains, mailboxes, messageBodies, messages, outboundJobs } from "@/db/schema";
import { newId } from "@/lib/ids";
import { buildSnippet } from "@/lib/email/parse";
import { dispatchWebhooks } from "@/lib/email/webhooks";
import { ensureEmailRoutingRuleToWorker } from "@/lib/cloudflare-api";
import { parseAddress } from "@/lib/utils";

export type SendEmailInput = {
	userId: string;
	from: string;
	to: string;
	subject: string;
	html?: string;
	text?: string;
	mailboxId?: string;
};

export async function validateSenderDomain(
	env: CloudflareEnv,
	userId: string,
	from: string,
): Promise<boolean> {
	const parsed = parseAddress(from);
	if (!parsed) return false;
	const db = getDb(env);
	const [domain] = await db
		.select()
		.from(domains)
		.where(and(eq(domains.hostname, parsed.domain), eq(domains.status, "active")))
		.limit(1);
	if (!domain) return false;

	const [mailbox] = await db
		.select()
		.from(mailboxes)
		.where(and(eq(mailboxes.domainId, domain.id), eq(mailboxes.localPart, parsed.local), eq(mailboxes.userId, userId)))
		.limit(1);

	if (!mailbox) return false;

	await ensureEmailRoutingRuleToWorker(env, domain.zoneId, `${parsed.local}@${parsed.domain}`);
	return true;
}

export async function sendEmail(env: CloudflareEnv, input: SendEmailInput): Promise<{ messageId: string }> {
	const db = getDb(env);
	const allowed = await validateSenderDomain(env, input.userId, input.from);
	if (!allowed) {
		throw new Error(`Sender address is not an active mailbox for your account: ${input.from}`);
	}

	const messageId = newId("msg");
	const snippet = buildSnippet(input.text ?? null, input.html ?? null);

	await db.insert(messages).values({
		id: messageId,
		userId: input.userId,
		mailboxId: input.mailboxId ?? null,
		direction: "outbound",
		fromAddr: input.from,
		toAddr: input.to,
		subject: input.subject,
		snippet,
		status: "queued",
	});

	await db.insert(messageBodies).values({
		id: newId(),
		messageId,
		textBody: input.text ?? null,
		htmlBody: input.html ?? null,
	});

	const jobId = newId("job");
	await db.insert(outboundJobs).values({
		id: jobId,
		userId: input.userId,
		messageId,
		status: "queued",
		payload: JSON.stringify(input),
	});

	try {
		const response = await env.EMAIL.send({
			from: input.from,
			to: input.to,
			subject: input.subject,
			html: input.html,
			text: input.text,
		});

		await db
			.update(messages)
			.set({ status: "sent", providerMessageId: response.messageId })
			.where(eq(messages.id, messageId));
		await db.update(outboundJobs).set({ status: "sent", updatedAt: new Date() }).where(eq(outboundJobs.id, jobId));

		await dispatchWebhooks(env, input.userId, "message.outbound", {
			messageId,
			providerMessageId: response.messageId,
			to: input.to,
		});

		return { messageId };
	} catch (err) {
		const error = err instanceof Error ? err.message : "Send failed";
		await db.update(messages).set({ status: "failed" }).where(eq(messages.id, messageId));
		await db
			.update(outboundJobs)
			.set({ status: "failed", error, updatedAt: new Date() })
			.where(eq(outboundJobs.id, jobId));
		await dispatchWebhooks(env, input.userId, "message.failed", { messageId, error });
		throw err;
	}
}

export type OutboundQueueMessage = SendEmailInput & { jobId?: string };

export async function processOutboundQueue(
	env: CloudflareEnv,
	payload: OutboundQueueMessage,
): Promise<void> {
	await sendEmail(env, payload);
}

import { processAgentDraftJob } from "@/lib/agent/jobs/utils";
import { createBatchBudget } from "@/lib/deliverability/ingest";
import { processInboundMessage } from "@/lib/email/inbound";
import { processOutboundQueue, type OutboundQueueMessage } from "@/lib/email/send";
import { processWebhookRetry, type WebhookRetryMessage } from "@/lib/email/webhooks";
import { processImportJob } from "@/lib/import/jobs";
import { isImportJobMessage, isInboundQueueMessage, isWebhookRetryMessage, settleFailedInboundMessage } from "../../worker-utils";
import { publishToQStash, queueDestination, QUEUE_MAX_RETRIES, type QStashConfig, type QueueName } from "./vercel-queue";

/** Routes a message by its shape, exactly as the `queue` handler in worker.ts does. */
async function dispatch(env: CloudflareEnv, body: unknown, attempt: number): Promise<void> {
	const kind = typeof body === "object" && body !== null ? (body as { kind?: unknown }).kind : undefined;
	if (isInboundQueueMessage(body)) await processInboundMessage(env, body, { reportBudget: createBatchBudget() });
	else if (kind === "agent.draft" && typeof (body as { jobId?: unknown }).jobId === "string") await processAgentDraftJob(env, (body as { jobId: string }).jobId);
	else if (isWebhookRetryMessage(body)) await processWebhookRetry(env, body as WebhookRetryMessage);
	else if (isImportJobMessage(body)) await processImportJob(env, { ...body, attempt });
	else if (kind === "email.scheduled") await processOutboundQueue(env, body as OutboundQueueMessage);
	else throw new Error("Unknown queue message type");
}

export type QueueOutcome = "done" | "retried" | "dropped";

/**
 * Processes one delivery. A failure re-publishes the message after the same delay the Worker would use, until
 * the queue's retry limit. Throws only when that re-publish fails, so QStash redelivers the original.
 */
export async function consumeQueueMessage(env: CloudflareEnv, config: QStashConfig, name: QueueName, body: unknown, attempt: number): Promise<QueueOutcome> {
	try {
		await dispatch(env, body, attempt);
		return "done";
	} catch (error) {
		console.error("Queue processing failed", { queue: name, attempts: attempt, rawR2Key: isInboundQueueMessage(body) ? body.rawR2Key : undefined, error });
		if (attempt > QUEUE_MAX_RETRIES[name]) return "dropped";
		let delaySeconds = 10;
		if (isInboundQueueMessage(body)) settleFailedInboundMessage({ retry: (options) => { delaySeconds = options.delaySeconds; } }, error);
		await publishToQStash(config, queueDestination(env.APP_URL!, name), { body, attempt: attempt + 1 }, delaySeconds);
		return "retried";
	}
}

import { processAgentDraftJob } from "@/lib/agent/jobs/utils";
import type { createBatchBudget } from "@/lib/deliverability/ingest";
import { processInboundMessage } from "@/lib/email/inbound";
import { processOutboundQueue, type OutboundQueueMessage } from "@/lib/email/send";
import { processWebhookRetry, type WebhookRetryMessage } from "@/lib/email/webhooks";
import { processImportJob } from "@/lib/import/jobs";
import { isImportJobMessage, isInboundQueueMessage, isWebhookRetryMessage } from "../../worker-utils";

/** Routes a queue message by its shape. The Workers `queue` handler and the Vercel consumer both call this. */
export async function dispatchQueueMessage(env: CloudflareEnv, body: unknown, options: { attempt: number; reportBudget: ReturnType<typeof createBatchBudget> }): Promise<void> {
	const kind = typeof body === "object" && body !== null ? (body as { kind?: unknown }).kind : undefined;
	if (isInboundQueueMessage(body)) await processInboundMessage(env, body, { reportBudget: options.reportBudget });
	else if (kind === "agent.draft" && typeof (body as { jobId?: unknown }).jobId === "string") await processAgentDraftJob(env, (body as { jobId: string }).jobId);
	else if (isWebhookRetryMessage(body)) await processWebhookRetry(env, body as WebhookRetryMessage);
	else if (isImportJobMessage(body)) await processImportJob(env, { ...body, attempt: options.attempt });
	else if (kind === "email.scheduled") await processOutboundQueue(env, body as OutboundQueueMessage);
	else throw new Error("Unknown queue message type");
}

import { createBatchBudget } from "@/lib/deliverability/ingest";
import { dispatchQueueMessage } from "@/lib/queue-dispatch";
import { isInboundQueueMessage, settleFailedInboundMessage } from "../../worker-utils";
import { isQueueName, publishToQStash, queueDestination, QUEUE_MAX_RETRIES, type QStashConfig, type QueueName, type VercelQueueMessage, type VercelQueues } from "./vercel-queue";

function logFailure(name: QueueName, body: unknown, attempt: number, error: unknown): void {
	console.error("Queue processing failed", { queue: name, attempts: attempt, rawR2Key: isInboundQueueMessage(body) ? body.rawR2Key : undefined, error });
}

/** The same delay the Worker would use. */
function retryDelaySeconds(body: unknown, error: unknown): number {
	let delaySeconds = 10;
	if (isInboundQueueMessage(body)) settleFailedInboundMessage({ retry: (options) => { delaySeconds = options.delaySeconds; } }, error);
	return delaySeconds;
}

export type QueueOutcome = "done" | "retried" | "dropped";

/**
 * Processes one QStash delivery. A failure re-publishes the message, until the queue's retry limit. Throws only
 * when that re-publish fails, so QStash redelivers the original.
 */
export async function consumeQueueMessage(env: CloudflareEnv, config: QStashConfig, name: QueueName, body: unknown, attempt: number): Promise<QueueOutcome> {
	try {
		await dispatchQueueMessage(env, body, { attempt, reportBudget: createBatchBudget() });
		return "done";
	} catch (error) {
		logFailure(name, body, attempt, error);
		if (attempt > QUEUE_MAX_RETRIES[name]) return "dropped";
		await publishToQStash(config, queueDestination(env.APP_URL!, name), { body, attempt: attempt + 1 }, retryDelaySeconds(body, error));
		return "retried";
	}
}

/** Thrown to leave a Vercel Queues message unacknowledged for this many seconds. */
export class QueueRetry extends Error {
	constructor(readonly afterSeconds: number) {
		super(`Retry in ${afterSeconds} seconds`);
		this.name = "QueueRetry";
	}
}

/** Deliveries of one five-minute message before it is given up; the daily cron restarts the schedule. */
const TICK_MAX_DELIVERIES = 3;
/** Under the function's own limit, so a slow run is acknowledged rather than started again. */
const TICK_TIMEOUT_MS = 290_000;

/** Calls the cron route on `APP_URL`, so the schedule follows production from one deployment to the next. */
async function runTick(env: CloudflareEnv, deliveryCount: number): Promise<void> {
	if (deliveryCount > TICK_MAX_DELIVERIES) return;
	const secret = (env as unknown as { CRON_SECRET?: string }).CRON_SECRET?.trim();
	let status: number;
	try {
		const response = await fetch(`${env.APP_URL}/api/internal/cron/frequent`, { headers: { Authorization: `Bearer ${secret}` }, signal: AbortSignal.timeout(TICK_TIMEOUT_MS) });
		status = response.status;
	} catch (error) {
		if (error instanceof Error && error.name === "TimeoutError") return;
		console.warn("The five-minute run could not be reached", error);
		throw new QueueRetry(60);
	}
	// 500 (a job failed) and 504 (it ran out of time) mean the route ran.
	if ((status >= 200 && status < 300) || status === 500 || status === 504) return;
	console.warn("The five-minute run was refused", { status });
	throw new QueueRetry(60);
}

/** Processes one Vercel Queues delivery. Returning acknowledges it; `QueueRetry` brings it back. */
export async function consumeVercelQueueMessage(env: CloudflareEnv, message: VercelQueueMessage, deliveryCount: number): Promise<void> {
	if (message?.queue === "tick") return runTick(env, deliveryCount);
	if (!message || !isQueueName(message.queue)) {
		console.error("Unknown queue message dropped");
		return;
	}
	// Any traffic restarts a schedule that stopped.
	await (env as unknown as { VERCEL_QUEUES?: VercelQueues }).VERCEL_QUEUES?.ensureTick();
	const { queue, body } = message;
	// A function that crashes or times out never reaches the catch below, so the limit is checked here too.
	if (deliveryCount > QUEUE_MAX_RETRIES[queue] + 1) {
		console.error("Queue message dropped past the retry limit", { queue, deliveryCount });
		return;
	}
	try {
		await dispatchQueueMessage(env, body, { attempt: deliveryCount, reportBudget: createBatchBudget() });
	} catch (error) {
		logFailure(queue, body, deliveryCount, error);
		if (deliveryCount > QUEUE_MAX_RETRIES[queue]) return;
		throw new QueueRetry(retryDelaySeconds(body, error));
	}
}

/** The SDK's retry hook. Anything else that threw (the SDK itself) gets a minute, up to the largest limit. */
export function vercelQueueRetry(error: unknown, metadata: { deliveryCount: number }): { afterSeconds: number } | { acknowledge: true } {
	if (error instanceof QueueRetry) return { afterSeconds: error.afterSeconds };
	return metadata.deliveryCount > QUEUE_MAX_RETRIES.inbound ? { acknowledge: true } : { afterSeconds: 60 };
}

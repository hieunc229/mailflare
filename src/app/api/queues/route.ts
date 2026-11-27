import { getEnv } from "@/lib/cloudflare";
import { isVercelRuntime } from "@/lib/runtime";
import type { VercelQueueMessage, VercelQueues } from "../../../../server/runtime/vercel-queue";
import { consumeVercelQueueMessage, vercelQueueRetry } from "../../../../server/runtime/vercel-queue-consumer";

export const dynamic = "force-dynamic";
/** Seconds; the ceiling of a Vercel Pro function. */
export const maxDuration = 300;

/**
 * The Vercel Queues consumer. The trigger in vercel.json makes this function private: only Vercel's queue
 * service can call it, so there is nothing to authenticate here. 404 on every other runtime, and when QStash
 * is the queue.
 */
export async function POST(request: Request) {
	if (!isVercelRuntime()) return new Response("Not found", { status: 404 });
	const env = getEnv();
	const queues = (env as unknown as { VERCEL_QUEUES?: VercelQueues }).VERCEL_QUEUES;
	if (!queues) return new Response("Not found", { status: 404 });
	const consume = queues.handleCallback<VercelQueueMessage>(
		(message, metadata) => consumeVercelQueueMessage(env, message, metadata.deliveryCount),
		{ retry: vercelQueueRetry },
	);
	return consume(request);
}

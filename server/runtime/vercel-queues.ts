/**
 * Vercel Queues, the default queue backend on Vercel. Every message goes to one topic, which vercel.json
 * delivers to `/api/queues`. This is the only module that imports the SDK, and only the Vercel env imports it.
 */
import { handleCallback, send } from "@vercel/queue";
import { assertQueueable, queueProducer, type QueueName, type VercelQueueMessage, type VercelQueues } from "./vercel-queue";

/** Must match the trigger in vercel.json. */
export const VERCEL_QUEUE_TOPIC = "mailflare";

const DAY_SECONDS = 24 * 60 * 60;
const MAX_SECONDS = 7 * DAY_SECONDS;
const TICK_SECONDS = 5 * 60;
/** A run this close to a five-minute mark counts as that mark's run, so the next one asks for the one after. */
const TICK_EARLY_SECONDS = 60;

export function openVercelQueue(name: QueueName) {
	return queueProducer(async (body, delaySeconds = 0) => {
		assertQueueable(body);
		const delay = Math.min(Math.ceil(delaySeconds), MAX_SECONDS);
		const message: VercelQueueMessage = { queue: name, body };
		// Retention counts from the send, and its default is one day: a long delay must not use all of it up.
		await send(VERCEL_QUEUE_TOPIC, message, delay > 0 ? { delaySeconds: delay, retentionSeconds: Math.min(delay + DAY_SECONDS, MAX_SECONDS) } : {});
	});
}

/**
 * Vercel Cron on Hobby runs once a day, so the five-minute jobs are driven by a delayed message: its consumer
 * calls the cron route, which asks for the next one. The idempotency key keeps it to one message per five
 * minutes however many instances ask. Only production keeps a schedule.
 */
export function openVercelQueues(vercelEnv: string | undefined, now: () => number = Date.now): VercelQueues {
	let requested = 0;
	return {
		handleCallback,
		async ensureTick() {
			if (vercelEnv && vercelEnv !== "production") return;
			const seconds = Math.floor(now() / 1000);
			const slot = Math.floor((seconds + TICK_EARLY_SECONDS) / TICK_SECONDS) + 1;
			if (slot === requested) return;
			try {
				const message: VercelQueueMessage = { queue: "tick" };
				await send(VERCEL_QUEUE_TOPIC, message, { delaySeconds: slot * TICK_SECONDS - seconds, idempotencyKey: `tick-${slot}`, retentionSeconds: 60 * 60 });
				requested = slot;
			} catch (error) {
				// The daily cron or the next queued message starts the schedule again.
				console.warn("Could not schedule the next five-minute run", error);
			}
		},
	};
}

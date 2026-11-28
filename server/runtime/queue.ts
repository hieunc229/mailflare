/**
 * The Queue producer API with an in-process consumer. Delivery order matches
 * wrangler.jsonc, and the inbound retry count matches Workers (12); Node adds
 * its own capped exponential back-off (10 s doubling to 300 s, about 40
 * minutes). The other queues retry three times, ten seconds apart. Jobs live
 * in memory and are not re-queued after a restart: inbound mail is already on
 * disk before it is enqueued, but a message whose job is lost stays
 * unprocessed in the blob store, and the raw-mail sweeper removes unreferenced
 * inbound files after 24 hours.
 */
export type QueueConsumer = (body: unknown) => Promise<void>;

export function inboundRetryDelayMs(retry: number): number {
	return Math.min(10_000 * 2 ** retry, 300_000);
}

type QueueOptions = { maxRetries?: number; retryDelayMs?: (retry: number) => number };

export const INBOUND_QUEUE_OPTIONS: QueueOptions = { maxRetries: 12, retryDelayMs: inboundRetryDelayMs };

type Pending = { body: unknown; attempts: number };

export class InProcessQueue {
	private consumer: QueueConsumer | null = null;
	private readonly maxRetries: number;
	private readonly retryDelayMs: (retry: number) => number;
	private readonly timers = new Set<ReturnType<typeof setTimeout>>();

	constructor(readonly name: string, options?: QueueOptions) {
		this.maxRetries = options?.maxRetries ?? 3;
		this.retryDelayMs = options?.retryDelayMs ?? (() => 10_000);
	}

	setConsumer(consumer: QueueConsumer) {
		this.consumer = consumer;
	}

	async send(body: unknown, options?: { delaySeconds?: number }) {
		this.schedule({ body, attempts: 0 }, (options?.delaySeconds ?? 0) * 1000);
	}

	async sendBatch(messages: Iterable<{ body: unknown; delaySeconds?: number }>) {
		for (const message of messages) await this.send(message.body, { delaySeconds: message.delaySeconds });
	}

	async metrics() {
		return { backlogCount: this.timers.size };
	}

	private schedule(pending: Pending, delayMs: number) {
		const timer = setTimeout(() => {
			this.timers.delete(timer);
			void this.deliver(pending);
		}, delayMs);
		this.timers.add(timer);
	}

	private async deliver(pending: Pending) {
		if (!this.consumer) {
			this.schedule(pending, 1000);
			return;
		}
		try {
			await this.consumer(pending.body);
		} catch (error) {
			console.error(`Queue ${this.name}: job failed`, error);
			if (pending.attempts < this.maxRetries) this.schedule({ body: pending.body, attempts: pending.attempts + 1 }, this.retryDelayMs(pending.attempts));
			else console.error(`Queue ${this.name}: giving up after ${this.maxRetries} retries`, pending.body);
		}
	}

	stop() {
		for (const timer of this.timers) clearTimeout(timer);
		this.timers.clear();
	}
}

export function openQueue<T>(name: string, options?: QueueOptions): Queue<T> & InProcessQueue {
	return new InProcessQueue(name, options) as unknown as Queue<T> & InProcessQueue;
}

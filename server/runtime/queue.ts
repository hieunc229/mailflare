/**
 * The Queue producer API with an in-process consumer. Delivery order and the
 * retry policy match wrangler.jsonc (three retries, ten seconds apart on
 * failure). Jobs live in memory: inbound mail is already on disk before it is
 * enqueued, so a restart at worst leaves a message unprocessed in the blob
 * store, never lost.
 */
export type QueueConsumer = (body: unknown) => Promise<void>;

type Pending = { body: unknown; attempts: number };

export class InProcessQueue {
	private consumer: QueueConsumer | null = null;
	private readonly maxRetries: number;
	private readonly timers = new Set<ReturnType<typeof setTimeout>>();

	constructor(readonly name: string, options?: { maxRetries?: number }) {
		this.maxRetries = options?.maxRetries ?? 3;
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
			if (pending.attempts < this.maxRetries) this.schedule({ body: pending.body, attempts: pending.attempts + 1 }, 10_000);
			else console.error(`Queue ${this.name}: giving up after ${this.maxRetries} retries`, pending.body);
		}
	}

	stop() {
		for (const timer of this.timers) clearTimeout(timer);
		this.timers.clear();
	}
}

export function openQueue<T>(name: string): Queue<T> & InProcessQueue {
	return new InProcessQueue(name) as unknown as Queue<T> & InProcessQueue;
}

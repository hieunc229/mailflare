import { no } from "./errors";

/**
 * Runs at most `limit` jobs at a time; the others wait in order, up to `maxWaiting` of them, and anything beyond that
 * is told the server is busy. A finished job hands its place straight to the next one waiting.
 */
export class Gate {
	private active = 0;
	private readonly waiting: Array<() => void> = [];

	constructor(
		readonly limit: number,
		readonly maxWaiting: number,
	) {}

	get running(): number {
		return this.active;
	}

	get queued(): number {
		return this.waiting.length;
	}

	async run<T>(job: () => Promise<T>): Promise<T> {
		if (this.active >= this.limit) {
			if (this.waiting.length >= this.maxWaiting) throw no("Server busy, try again", "LIMIT");
			await new Promise<void>((resolve) => this.waiting.push(resolve));
		} else this.active += 1;
		try {
			return await job();
		} finally {
			const next = this.waiting.shift();
			if (next) next();
			else this.active -= 1;
		}
	}
}

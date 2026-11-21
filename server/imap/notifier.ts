/**
 * Tells sessions that a mailbox changed. One poller for the whole process reads the
 * change revision of the mailboxes that have a selected folder (one query, ids in
 * chunks), every few seconds; a nudge (new mail announced through the realtime hub)
 * makes it check at once. A session only learns *that* something changed; it
 * brings its own view up to date when it is ready for it.
 */
export type Watcher = { userId: string; listener: () => void };

type Env = Pick<CloudflareEnv, "DB">;
/** What the realtime hub offers: a way to hear that something happened for a user (new mail announces itself this way). */
export type RealtimeSource = { subscribe(userId: string, listener: (payload: unknown) => void): () => void };

export class Notifier {
	private readonly watchers = new Map<string, Set<Watcher>>();
	private readonly seen = new Map<string, number>();
	private timer: NodeJS.Timeout | null = null;
	private running = false;
	private again = false;
	private nudgeTimer: NodeJS.Timeout | null = null;
	private readonly users = new Map<string, { count: number; unsubscribe: (() => void) | null }>();

	constructor(private readonly env: Env, private readonly intervalMs = 5000, private readonly realtime?: RealtimeSource) {}

	start(): void {
		if (this.timer) return;
		this.timer = setInterval(() => void this.check(), this.intervalMs);
		this.timer.unref();
	}

	stop(): void {
		if (this.timer) clearInterval(this.timer);
		if (this.nudgeTimer) clearTimeout(this.nudgeTimer);
		this.timer = this.nudgeTimer = null;
	}

	private async revisions(ids: string[]): Promise<Map<string, number>> {
		const result = new Map<string, number>();
		for (let at = 0; at < ids.length; at += 90) {
			const chunk = ids.slice(at, at + 90);
			const marks = chunk.map(() => "?").join(", ");
			const rows = (await this.env.DB.prepare(`SELECT mailbox_id, revision FROM jmap_mailbox_revisions WHERE mailbox_id IN (${marks})`).bind(...chunk).all<{ mailbox_id: string; revision: number }>()).results;
			for (const row of rows) result.set(row.mailbox_id, Number(row.revision));
		}
		return result;
	}

	/**
	 * Starts watching a mailbox for a user. The current revision is recorded before this
	 * returns, so a change made after the caller reads its own state is reported.
	 */
	async watch(mailboxId: string, userId: string, listener: () => void): Promise<() => void> {
		const watcher: Watcher = { userId, listener };
		const set = this.watchers.get(mailboxId) ?? new Set();
		set.add(watcher);
		this.watchers.set(mailboxId, set);
		const user = this.users.get(userId) ?? { count: 0, unsubscribe: null };
		user.count += 1;
		if (!user.unsubscribe && this.realtime) user.unsubscribe = this.realtime.subscribe(userId, () => this.nudge(userId));
		this.users.set(userId, user);
		if (!this.seen.has(mailboxId)) this.seen.set(mailboxId, (await this.revisions([mailboxId])).get(mailboxId) ?? 0);
		let released = false;
		return () => {
			if (released) return;
			released = true;
			user.count -= 1;
			if (user.count <= 0) {
				user.unsubscribe?.();
				this.users.delete(userId);
			}
			set.delete(watcher);
			if (!set.size && this.watchers.get(mailboxId) === set) {
				this.watchers.delete(mailboxId);
				this.seen.delete(mailboxId);
			}
		};
	}

	/** Mailboxes watched at the moment, for the admin status view and tests. */
	get watchedMailboxes(): number {
		return this.watchers.size;
	}

	/** Something happened for this user (the realtime hub told us): look soon, not at the next tick. */
	nudge(userId: string): void {
		if (![...this.watchers.values()].some((set) => [...set].some((watcher) => watcher.userId === userId))) return;
		if (this.nudgeTimer) return;
		this.nudgeTimer = setTimeout(() => {
			this.nudgeTimer = null;
			void this.check();
		}, 50);
		this.nudgeTimer.unref();
	}

	async check(): Promise<void> {
		if (this.running) {
			this.again = true;
			return;
		}
		this.running = true;
		try {
			do {
				this.again = false;
				const ids = [...this.watchers.keys()];
				if (!ids.length) break;
				const current = await this.revisions(ids);
				for (const id of ids) {
					const revision = current.get(id) ?? 0;
					if (revision === this.seen.get(id)) continue;
					this.seen.set(id, revision);
					for (const watcher of [...(this.watchers.get(id) ?? [])]) {
						try {
							watcher.listener();
						} catch (error) {
							console.warn("IMAP change listener failed", error);
						}
					}
				}
			} while (this.again);
		} catch (error) {
			console.warn("IMAP change check failed", error);
		} finally {
			this.running = false;
		}
	}
}

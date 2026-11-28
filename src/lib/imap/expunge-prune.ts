/**
 * Drops `imap_expunged` rows older than 30 days (spec 8.7). A QRESYNC client asks "what
 * vanished since mod-sequence m", and the answer is only complete while every expunge row
 * above m is still there. So the rows and a per-folder floor change together, in one batch:
 * `imap_folder_state.expunged_floor` becomes the highest mod-sequence among the rows that go,
 * and every row at or below it goes with them (also a newer-looking one with a lower
 * mod-sequence, which a writer with a different clock can produce), so "modseq above the
 * floor" always means "complete". Readers decide with `expunged_floor`: at or above it the
 * rows answer exactly; below it the answer is computed from what the client knows (view.ts).
 *
 * Rows of a mailbox that no longer exists (nothing cascades into this table) have no folder
 * state to hold a floor and are dropped the same way once they are old.
 */
type PruneEnv = Pick<CloudflareEnv, "DB">;

export const EXPUNGED_RETENTION_SECONDS = 30 * 24 * 60 * 60;
/** Old rows looked at per round, folders handled per round, and rounds per run; a larger backlog continues at the next run. */
const OLD_ROWS_PER_ROUND = 1000;
const GROUPS_PER_ROUND = 100;
const MAX_ROUNDS = 50;

export async function pruneImapExpunged(env: PruneEnv, now = new Date()): Promise<number> {
	const cutoff = Math.floor(now.getTime() / 1000) - EXPUNGED_RETENTION_SECONDS;
	let removed = 0;
	for (let round = 0; round < MAX_ROUNDS; round += 1) {
		// The old rows in the order of the age index (it covers the query), so a round costs the rows it looks at, not the table. The rows of a
		// folder that were not in this page are old too and go in a later round: a floor is exact for any highest mod-sequence of rows dropped
		// together with everything below it.
		const old = (await env.DB.prepare("SELECT mailbox_id, folder_key, modseq FROM imap_expunged WHERE created_at < ? ORDER BY created_at LIMIT ?").bind(cutoff, OLD_ROWS_PER_ROUND).all<{ mailbox_id: string; folder_key: string; modseq: number }>()).results;
		if (!old.length) break;
		const groups = new Map<string, { mailboxId: string; folderKey: string; top: number }>();
		for (const row of old) {
			const key = JSON.stringify([row.mailbox_id, row.folder_key]);
			const group = groups.get(key) ?? { mailboxId: row.mailbox_id, folderKey: row.folder_key, top: 0 };
			group.top = Math.max(group.top, Number(row.modseq));
			groups.set(key, group);
		}
		const handled = [...groups.values()].slice(0, GROUPS_PER_ROUND);
		for (const group of handled) {
			const results = await env.DB.batch([
				// The mailbox's state row is locked first, as a sync's batch does, so the two take their locks in the same order and cannot wait on each other.
				env.DB.prepare("UPDATE imap_mailbox_state SET modseq = modseq WHERE mailbox_id = ?").bind(group.mailboxId),
				// The floor goes next: a reader that finds the rows gone has already been able to see the floor.
				env.DB.prepare("UPDATE imap_folder_state SET expunged_floor = ? WHERE id = ? AND expunged_floor < ?").bind(group.top, `${group.mailboxId}:${group.folderKey}`, group.top),
				env.DB.prepare("DELETE FROM imap_expunged WHERE mailbox_id = ? AND folder_key = ? AND modseq <= ?").bind(group.mailboxId, group.folderKey, group.top),
			]);
			removed += Number((results[2] as { meta?: { changes?: number } }).meta?.changes ?? 0);
		}
		if (old.length < OLD_ROWS_PER_ROUND && handled.length === groups.size) break;
	}
	return removed;
}

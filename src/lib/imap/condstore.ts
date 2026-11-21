import type { FolderView } from "./view";

/**
 * CONDSTORE and QRESYNC data (RFC 7162, spec 8.7): mod-sequences per message, and the UIDs that
 * vanished from a folder since a mod-sequence. Mod-sequences are written only by the sync engine;
 * everything here reads them.
 */
type Env = Pick<CloudflareEnv, "DB">;
export type UidRange = [number, number];

const ID_CHUNK = 90;
/** UIDs read per page of the expunge log, and ranges per VANISHED line. */
const PAGE = 5000;
export const RANGES_PER_LINE = 1000;

/**
 * A mod-sequence a client sent: digits only, at most 19 of them. A value no number can hold exactly
 * becomes the largest one that can, which is above every mod-sequence this server hands out. Null when it is not a number.
 */
export function parseModseq(text: string): number | null {
	if (!/^\d{1,19}$/.test(text)) return null;
	const value = Number(text);
	return Number.isSafeInteger(value) ? value : Number.MAX_SAFE_INTEGER;
}

/** `ranges` without the UIDs in `present` (ascending): the cost is the number of UIDs present, never the size of a range. */
export function subtractPresent(ranges: UidRange[], present: number[]): UidRange[] {
	const result: UidRange[] = [];
	for (const [low, high] of ranges) {
		let next = low;
		let index = lowerIndex(present, low);
		while (next <= high) {
			if (index < present.length && present[index] <= high) {
				if (present[index] > next) result.push([next, present[index] - 1]);
				next = present[index] + 1;
				index += 1;
			} else {
				result.push([next, high]);
				break;
			}
		}
	}
	return result;
}

function lowerIndex(sorted: number[], value: number): number {
	let low = 0;
	let high = sorted.length;
	while (low < high) {
		const middle = (low + high) >>> 1;
		if (sorted[middle] < value) low = middle + 1;
		else high = middle;
	}
	return low;
}

export const formatRanges = (ranges: UidRange[]): string => ranges.map(([low, high]) => (low === high ? String(low) : `${low}:${high}`)).join(",");

const marks = (count: number) => Array.from({ length: count }, () => "?").join(", ");

/** The mod-sequence of each of these UIDs (those the folder has). */
export async function modseqsOf(env: Env, mailboxId: string, folderKey: string, uids: number[]): Promise<Map<number, number>> {
	const result = new Map<number, number>();
	for (let at = 0; at < uids.length; at += ID_CHUNK) {
		const part = uids.slice(at, at + ID_CHUNK);
		const rows = (await env.DB.prepare(`SELECT uid, modseq FROM imap_uids WHERE mailbox_id = ? AND folder_key = ? AND uid IN (${marks(part.length)})`).bind(mailboxId, folderKey, ...part).all<{ uid: number; modseq: number }>()).results;
		for (const row of rows) result.set(Number(row.uid), Number(row.modseq));
	}
	return result;
}

/** Every UID of the folder with its mod-sequence: one query, the size of the folder, which a session holds anyway. */
export async function folderModseqs(env: Env, mailboxId: string, folderKey: string): Promise<Map<number, number>> {
	const rows = (await env.DB.prepare("SELECT uid, modseq FROM imap_uids WHERE mailbox_id = ? AND folder_key = ?").bind(mailboxId, folderKey).all<{ uid: number; modseq: number }>()).results;
	return new Map(rows.map((row) => [Number(row.uid), Number(row.modseq)]));
}

/** The UIDs of the folder changed after `since` (a new message and a flag change both count). */
export async function changedSince(env: Env, mailboxId: string, folderKey: string, since: number): Promise<Set<number>> {
	const rows = (await env.DB.prepare("SELECT uid FROM imap_uids WHERE mailbox_id = ? AND folder_key = ? AND modseq > ?").bind(mailboxId, folderKey, since).all<{ uid: number }>()).results;
	return new Set(rows.map((row) => Number(row.uid)));
}

async function readFloor(env: Env, mailboxId: string, folderKey: string): Promise<number> {
	const [row] = (await env.DB.prepare("SELECT expunged_floor FROM imap_folder_state WHERE id = ?").bind(`${mailboxId}:${folderKey}`).all<{ expunged_floor: number }>()).results;
	return Number(row?.expunged_floor ?? 0);
}

const insideAny = (ranges: UidRange[], uid: number) => ranges.some(([low, high]) => uid >= low && uid <= high);

/**
 * The UIDs that vanished from the folder after mod-sequence `since`, as ascending ranges, limited to
 * `within` when the client named the UIDs it cares about.
 *
 * While the expunge log is complete above `since` (the folder's floor is not above it) the log answers.
 * The log is read before the floor: pruning writes the floor first, so a reader that missed rows
 * because they were pruned meanwhile also sees the floor and takes the other path. Below the
 * floor some rows may be gone, and the answer comes from the UIDs that exist: UIDs are never reused,
 * so a UID below `uid_next` that the folder does not hold has vanished. That is the same set, found
 * the slower way (RFC 7162 section 3.2.5.1: the server may answer from what the client knows).
 */
export async function vanishedSince(env: Env, view: FolderView, since: number, within: UidRange[] | null): Promise<UidRange[]> {
	const found: UidRange[] = [];
	for (let cursor = 0; ; ) {
		const page = (await env.DB.prepare("SELECT uid FROM imap_expunged WHERE mailbox_id = ? AND folder_key = ? AND modseq > ? AND uid > ? ORDER BY uid LIMIT ?").bind(view.mailboxId, view.folderKey, since, cursor, PAGE).all<{ uid: number }>()).results;
		for (const row of page) {
			const uid = Number(row.uid);
			if (within && !insideAny(within, uid)) continue;
			const last = found[found.length - 1];
			if (last && last[1] + 1 === uid) last[1] = uid;
			else found.push([uid, uid]);
		}
		if (page.length < PAGE) break;
		cursor = Number(page[page.length - 1].uid);
	}
	if ((await readFloor(env, view.mailboxId, view.folderKey)) <= since) return found;
	const top = view.uidNext - 1;
	const candidates: UidRange[] = (within ?? [[1, top]]).map(([low, high]): UidRange => [Math.max(low, 1), Math.min(high, top)]).filter(([low, high]) => low <= high);
	return subtractPresent(candidates, view.uids);
}

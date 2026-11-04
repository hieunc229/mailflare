export function quoteImapString(value: string): string {
	return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

export function parseSearchUids(line: string): string[] {
	const match = line.match(/^\* SEARCH(?:\s+(.+))?$/i);
	if (!match?.[1]) return [];
	return match[1].trim().split(/\s+/).filter((value) => /^\d+$/.test(value));
}

export type ImapUidBatch = {
	uids: string[];
	total: number;
	/** Offset to pass on the next request, or null when the folder is fully covered. */
	nextOffset: number | null;
};

/**
 * Picks one batch of UIDs, newest first. `offset` is how many of the newest
 * messages earlier batches already covered, so repeated requests with the
 * returned `nextOffset` walk back through the whole folder.
 */
export function selectImapUidBatch(allUids: string[], limit: number, offset: number): ImapUidBatch {
	const total = allUids.length;
	const safeOffset = Math.min(Math.max(Math.floor(offset) || 0, 0), total);
	const end = total - safeOffset;
	const start = Math.max(0, end - Math.max(Math.floor(limit) || 1, 1));
	const nextOffset = start > 0 ? safeOffset + (end - start) : null;
	return { uids: allUids.slice(start, end), total, nextOffset };
}

/**
 * Messages to fetch in one chunk. `size` is the size the job settled on after
 * earlier trouble; every redelivery of the same queue message (`attempt` > 1,
 * e.g. the Worker died with a resource-limit 503) halves it again.
 */
export function getImapChunkSize(base: number, size: number | undefined, attempt = 1): number {
	const current = Math.min(Math.max(Math.floor(size ?? base) || base, 1), base);
	return Math.max(1, Math.floor(current / 2 ** Math.max(attempt - 1, 0)));
}

/** After a clean chunk, climb back towards `base` gradually rather than all at once. */
export function growImapChunkSize(base: number, size: number): number {
	return size >= base ? base : Math.min(base, size + Math.max(1, Math.floor(size / 2)));
}

/** Errors a smaller batch cannot fix: bad credentials, lost settings. */
export function isPermanentImapError(message: string): boolean {
	return /login|auth|credential|not allowed|unreadable|no longer exists/i.test(message);
}

/** A folder the server says does not exist or cannot be selected, such as Gmail's `[Gmail]` parent. */
export function isMissingImapFolderError(message: string): boolean {
	return /NONEXISTENT|unknown mailbox|mailbox (?:does not|doesn't) exist|nonexistent namespace|NOSELECT/i.test(message);
}

/** FETCH commands sent back to back, and the raw mail one group may hold before the next is requested. */
const IMAP_PIPELINE_COUNT = 10;
const IMAP_PIPELINE_BYTES = 4 * 1024 * 1024;
// Every fetched message is held in memory and then parsed and stored within one
// Worker request, so a batch stops early once it holds this much raw mail.
export const MAX_IMAP_BATCH_BYTES = 20 * 1024 * 1024;

/**
 * Splits UIDs (newest first) into groups to pipeline, dropping the tail that would
 * push the batch past the memory budget. A UID with an unknown size travels alone.
 */
export function planImapFetchGroups(uids: string[], sizes: Map<string, number>): string[][] {
	const groups: string[][] = [];
	let current: string[] = [];
	let currentBytes = 0;
	let planned = 0;
	for (const uid of uids) {
		if (planned >= MAX_IMAP_BATCH_BYTES) break;
		const size = sizes.get(uid);
		if (size === undefined) {
			if (current.length) groups.push(current);
			groups.push([uid]);
			current = [];
			currentBytes = 0;
			planned = MAX_IMAP_BATCH_BYTES;
			continue;
		}
		current.push(uid);
		currentBytes += size;
		planned += size;
		if (current.length >= IMAP_PIPELINE_COUNT || currentBytes >= IMAP_PIPELINE_BYTES) {
			groups.push(current);
			current = [];
			currentBytes = 0;
		}
	}
	if (current.length) groups.push(current);
	return groups;
}

export function getLiteralLength(line: string): number | null {
	const match = line.match(/\{(\d+)\}$/);
	return match ? Number(match[1]) : null;
}

/** Uppercased flags from a FETCH response line, or null when the line has none. */
export function parseFetchFlags(line: string): string[] | null {
	const match = line.match(/\bFLAGS \(([^)]*)\)/i);
	if (!match) return null;
	return match[1].trim().split(/\s+/).filter(Boolean).map((flag) => flag.toUpperCase());
}

export function isTaggedCompletion(line: string, tag: string): boolean {
	return line.toUpperCase().startsWith(`${tag.toUpperCase()} `);
}

export function parseListMailboxName(line: string): string | null {
	const match = line.match(/^\* LIST\s+\([^\)]*\)\s+(?:"[^"]*"|NIL)\s+(.+)$/i);
	if (!match?.[1]) return null;
	const value = match[1].trim();
	if (value.startsWith('"') && value.endsWith('"')) {
		return value.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
	}
	return value || null;
}

export function assertSafeImapHost(host: string): void {
	const value = host.trim().toLowerCase();
	if (!value || value === "localhost" || value.endsWith(".local")) {
		throw new Error("IMAP host is not allowed");
	}
	if (/^\d+\.\d+\.\d+\.\d+$/.test(value)) {
		const parts = value.split(".").map(Number);
		if (
			parts[0] === 10 ||
			parts[0] === 127 ||
			(parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
			(parts[0] === 192 && parts[1] === 168) ||
			(parts[0] === 169 && parts[1] === 254)
		) {
			throw new Error("Private IMAP hosts are not allowed");
		}
	}
}

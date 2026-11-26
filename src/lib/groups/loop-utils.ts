export const GROUP_HEADER = "X-Mailflare-Group";
/** More hops than this means the message is going around in a loop. */
export const MAX_RECEIVED_HOPS = 30;

/** The `List-Id` identifier of a group, lower-cased: `local.hostname`. */
export function groupListIdentifier(localPart: string, hostname: string): string {
	return `${localPart}.${hostname}`.toLowerCase();
}

function header(headers: Record<string, string>, name: string): string | undefined {
	const wanted = name.toLowerCase();
	for (const [key, value] of Object.entries(headers)) if (key.toLowerCase() === wanted) return value;
	return undefined;
}

export type GroupDropInput = {
	groupId: string;
	listIdentifier: string;
	headers: Record<string, string>;
	receivedHops: number;
};

/**
 * Why inbound mail to a group must be dropped silently (never rejected: a bounce would feed the
 * loop), or null. Silence is the point: it ends group, external, group loops and auto-reply storms.
 */
export function groupDropReason(input: GroupDropInput): string | null {
	if (header(input.headers, GROUP_HEADER)?.trim() === input.groupId) return "group marker";
	const listId = header(input.headers, "list-id");
	if (listId) {
		const identifier = (/<([^<>]*)>\s*$/.exec(listId.trim())?.[1] ?? listId).trim().toLowerCase();
		if (identifier === input.listIdentifier.toLowerCase()) return "own list id";
	}
	const autoSubmitted = header(input.headers, "auto-submitted")?.trim().toLowerCase();
	if (autoSubmitted && autoSubmitted !== "no") return "auto-submitted";
	if (input.receivedHops > MAX_RECEIVED_HOPS) return "too many hops";
	return null;
}

/** Counts `Received` headers in the header block of a raw message (first 256 KiB). */
export function countReceivedHeaders(raw: ArrayBuffer): number {
	const text = new TextDecoder("latin1").decode(new Uint8Array(raw, 0, Math.min(raw.byteLength, 256 * 1024)));
	const end = text.search(/\r?\n\r?\n/);
	const block = end >= 0 ? text.slice(0, end) : text;
	return block.split(/\r?\n/).filter((line) => /^received:/i.test(line)).length;
}

/**
 * Counts hops in a `Received` value that a header map joined with ", " (the Worker handler's
 * `Object.fromEntries(headers)`): every Received line ends with "; <date>".
 */
export function countReceivedInJoinedValue(value: string | undefined): number {
	if (!value) return 0;
	return value.match(/;\s*(?:[A-Za-z]{3},\s*)?\d{1,2}\s+[A-Za-z]{3}\s+\d{4}/g)?.length ?? 0;
}

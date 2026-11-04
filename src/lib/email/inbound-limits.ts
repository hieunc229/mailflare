import type { ParsedEmail } from "@/lib/email/parse";

/** Column budgets that hold on D1 (2 MB rows), MySQL varchar keys and PostgreSQL btree entries. */
export const INBOUND_LIMITS = {
	textBodyBytes: 450_000,
	htmlBodyBytes: 900_000,
	messageIdChars: 512,
	subjectChars: 998,
	addressChars: 998,
	addressListChars: 8_000,
	referencesCount: 20,
} as const;

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: false });

export function truncateUtf8(value: string, maxBytes: number): string {
	// UTF-8 needs at most 4 bytes a character, so anything shorter than a quarter always fits.
	if (value.length * 4 <= maxBytes) return value;
	const bytes = encoder.encode(value);
	if (bytes.byteLength <= maxBytes) return value;
	// A cut inside a multi-byte sequence decodes to a replacement character; drop it.
	return decoder.decode(bytes.subarray(0, maxBytes)).replace(/�+$/u, "");
}

/** Truncate to `max` UTF-16 units without leaving half of a surrogate pair at the end. */
export function capChars(value: string | null, max: number): string | null {
	if (!value || value.length <= max) return value;
	const last = value.charCodeAt(max - 1);
	return value.slice(0, last >= 0xd800 && last <= 0xdbff ? max - 1 : max);
}

function boundedId(value: string | null): string | null {
	return value && value.length <= INBOUND_LIMITS.messageIdChars ? value : null;
}

/**
 * Keep every stored field inside what all three databases accept, so a hostile or merely odd
 * message is stored (the full original stays in raw MIME) instead of failing the insert and
 * being retried until it is dropped.
 */
export function boundParsedEmail(parsed: ParsedEmail): ParsedEmail {
	return {
		...parsed,
		subject: capChars(parsed.subject, INBOUND_LIMITS.subjectChars),
		text: parsed.text === null ? null : truncateUtf8(parsed.text, INBOUND_LIMITS.textBodyBytes),
		html: parsed.html === null ? null : truncateUtf8(parsed.html, INBOUND_LIMITS.htmlBodyBytes),
		messageId: boundedId(parsed.messageId),
		fromAddr: capChars(parsed.fromAddr, INBOUND_LIMITS.addressChars),
		toAddr: capChars(parsed.toAddr, INBOUND_LIMITS.addressListChars),
		ccAddr: capChars(parsed.ccAddr, INBOUND_LIMITS.addressListChars),
		bccAddr: capChars(parsed.bccAddr, INBOUND_LIMITS.addressListChars),
		replyTo: capChars(parsed.replyTo, INBOUND_LIMITS.addressListChars),
		inReplyTo: boundedId(parsed.inReplyTo),
		references: parsed.references.filter((id) => id.length <= INBOUND_LIMITS.messageIdChars).slice(-INBOUND_LIMITS.referencesCount),
	};
}

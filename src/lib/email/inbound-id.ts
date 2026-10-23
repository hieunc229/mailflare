export async function inboundMessageId(rawR2Key: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(rawR2Key));
	const hex = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
	return `msg_${hex}`;
}

async function sha256Hex(parts: (string | Uint8Array)[]): Promise<string> {
	const encoder = new TextEncoder();
	const buffers = parts.map((part) => (typeof part === "string" ? encoder.encode(part) : part));
	const joined = new Uint8Array(buffers.reduce((total, buffer) => total + buffer.length, 0));
	let offset = 0;
	for (const buffer of buffers) {
		joined.set(buffer, offset);
		offset += buffer.length;
	}
	const digest = await crypto.subtle.digest("SHA-256", joined);
	return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Reads the RFC 5322 `Message-ID` header from a raw message without a full MIME
 * parse. The header name is case-insensitive and folded continuation lines are
 * unfolded. Returns null when the header is absent.
 */
export function extractMessageIdHeader(raw: ArrayBuffer): string | null {
	const bytes = new Uint8Array(raw);
	let headerEnd = bytes.length;
	for (let i = 0; i + 1 < bytes.length; i++) {
		if (bytes[i] === 0x0a && bytes[i + 1] === 0x0a) {
			headerEnd = i + 1;
			break;
		}
		if (bytes[i] === 0x0d && bytes[i + 1] === 0x0a && i + 3 < bytes.length && bytes[i + 2] === 0x0d && bytes[i + 3] === 0x0a) {
			headerEnd = i + 2;
			break;
		}
	}
	const headerBlock = new TextDecoder("latin1").decode(bytes.subarray(0, headerEnd));
	const unfolded = headerBlock.replace(/\r?\n[ \t]/g, " ");
	for (const line of unfolded.split("\n")) {
		const match = line.replace(/\r$/, "").match(/^message-id:[ \t]*(.*)$/i);
		if (match) return match[1].trim();
	}
	return null;
}

/**
 * Deterministic storage key for an inbound message. A relay retry delivers the
 * same RFC `Message-ID`, so keying on it (scoped by mailbox) makes a retry
 * overwrite the same object; the inbound queue consumer already dedupes by
 * `(mailboxId, rawR2Key)`. Messages without a `Message-ID` fall back to a
 * content hash so identical deliveries are still idempotent.
 */
export async function inboundStorageKey(raw: ArrayBuffer, mailboxId?: string): Promise<string> {
	const messageId = extractMessageIdHeader(raw);
	if (messageId) return `inbound/${await sha256Hex([mailboxId ?? "", messageId])}.eml`;
	return `inbound/${await sha256Hex([mailboxId ?? "", new Uint8Array(raw)])}.eml`;
}

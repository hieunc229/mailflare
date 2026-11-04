/**
 * Cheap, linear raw-byte scan that rejects MIME shapes known to make the parser burn CPU or
 * memory (header floods, thousands of parts, endless nested message/rfc822, line floods in text parts).
 * Runs before any decode, so a hostile message costs one pass over the bytes.
 */
export const MIME_LIMITS = {
	maxHeaderBytes: 64 * 1024,
	maxBoundaryLines: 1_000,
	maxNestedMessages: 20,
	// Lines outside base64 parts: postal-mime spends memory per line there, so 262k lines of
	// any length exhaust a 128 MB heap. Base64 attachment lines are chunked and stay cheap.
	maxTextLines: 40_000,
	maxNestingDepth: 20,
} as const;

const NEWLINE = 10;
const CARRIAGE_RETURN = 13;
const DASH = 45;
const MESSAGE_RFC822 = "message/rfc822";

function startsWithAscii(bytes: Uint8Array, start: number, end: number, prefix: string): boolean {
	if (end - start < prefix.length) return false;
	for (let i = 0; i < prefix.length; i++) {
		if ((bytes[start + i] | 0x20) !== prefix.charCodeAt(i)) return false;
	}
	return true;
}

function lineContainsAscii(bytes: Uint8Array, start: number, end: number, needle: string): boolean {
	const limit = Math.min(end, start + 256) - needle.length;
	for (let i = start; i <= limit; i++) {
		let matched = true;
		for (let j = 0; j < needle.length; j++) {
			if ((bytes[i + j] | 0x20) !== needle.charCodeAt(j)) {
				matched = false;
				break;
			}
		}
		if (matched) return true;
	}
	return false;
}

export function mimePreflightReason(raw: ArrayBuffer | Uint8Array): string | null {
	const bytes = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
	let boundaryLines = 0;
	let nestedMessages = 0;
	let textLines = 0;
	let headerEnded = false;
	// Tracks the current part's header block and transfer encoding to tell base64 from text lines.
	let inPartHeaders = true;
	let partIsBase64 = false;

	let lineStart = 0;
	while (lineStart < bytes.length) {
		let lineEnd = bytes.indexOf(NEWLINE, lineStart);
		if (lineEnd === -1) lineEnd = bytes.length;
		let contentEnd = lineEnd;
		if (contentEnd > lineStart && bytes[contentEnd - 1] === CARRIAGE_RETURN) contentEnd--;

		const isBoundary = contentEnd - lineStart > 2 && bytes[lineStart] === DASH && bytes[lineStart + 1] === DASH;
		if (contentEnd === lineStart) {
			headerEnded = true;
			inPartHeaders = false;
		} else if (!headerEnded && lineEnd > MIME_LIMITS.maxHeaderBytes) {
			return "Message rejected: header block exceeds 64 KiB.";
		} else if (isBoundary) {
			if (++boundaryLines > MIME_LIMITS.maxBoundaryLines) {
				return "Message rejected: too many MIME parts.";
			}
			inPartHeaders = true;
			partIsBase64 = false;
			lineStart = lineEnd + 1;
			continue;
		} else {
			// Not limited to part headers: a nested message restarts its own header block.
			if (startsWithAscii(bytes, lineStart, contentEnd, "content-type:") && lineContainsAscii(bytes, lineStart, contentEnd, MESSAGE_RFC822)) {
				if (++nestedMessages > MIME_LIMITS.maxNestedMessages) {
					return "Message rejected: too many nested messages.";
				}
			}
			if (inPartHeaders && startsWithAscii(bytes, lineStart, contentEnd, "content-transfer-encoding:") && lineContainsAscii(bytes, lineStart, contentEnd, "base64")) {
				partIsBase64 = true;
			}
		}
		if (!inPartHeaders && !partIsBase64 && ++textLines > MIME_LIMITS.maxTextLines) {
			return "Message rejected: malformed MIME structure (too many lines).";
		}
		lineStart = lineEnd + 1;
	}
	return null;
}

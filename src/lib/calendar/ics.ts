/** Shared iCalendar (RFC 5545) writing helpers for the feed, outgoing invitations and invitation replies. */

/** Longest mailbox allowed by RFC 5321 (254 in practice); anything longer is never tested or written. */
export const MAX_ICS_ADDRESS = 320;

/**
 * A calendar address must be one plain mailbox; anything with whitespace or separators is left out of the file.
 * The local part excludes @ so a long run of @ cannot backtrack quadratically, and the length is capped before the test.
 */
export function isIcsAddress(value: string): boolean {
	return value.length <= MAX_ICS_ADDRESS && /^[^\s<>",;:@]+@[^\s<>",;:@]+$/.test(value);
}

export function escapeIcsText(value: string): string {
	// Control characters other than tab and line breaks are dropped, and every line-break form (CRLF, CR, LF) becomes
	// the \n escape. A bare CR left in the output would let event text start a new property line.
	return value
		.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
		.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,")
		.replace(/\r\n|\r|\n/g, "\\n");
}

/** RFC 5545 section 3.1: lines over 75 octets are folded with CRLF + space. Folds on code point boundaries. */
export function foldIcsLine(line: string): string {
	const encoder = new TextEncoder();
	if (encoder.encode(line).length <= 75) return line;
	const parts: string[] = [];
	let current = "";
	let size = 0;
	let limit = 75;
	for (const char of line) {
		const bytes = encoder.encode(char).length;
		if (size + bytes > limit) {
			parts.push(current);
			current = "";
			size = 0;
			limit = 74;
		}
		current += char;
		size += bytes;
	}
	parts.push(current);
	return parts.join("\r\n ");
}

/** A UTC DATE-TIME value such as 20261104T170000Z. */
export function formatIcsUtc(value: Date): string {
	return value.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

/** Folds every line and joins them with CRLF, ending with the trailing CRLF the RFC requires. */
export function joinIcsLines(lines: string[]): string {
	return `${lines.map(foldIcsLine).join("\r\n")}\r\n`;
}

import { truncateUtf8 } from "@/lib/email/inbound-limits";

// eslint-disable-next-line no-control-regex
const CONTROL_AND_BIDI = /[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;

export function getAttachmentContentDisposition(filename: string, inline: boolean): string {
	// Rows stored before filenames were capped can still be long; keep the header bounded.
	const cleaned = truncateUtf8(filename.replace(CONTROL_AND_BIDI, "").trim(), 180) || "attachment";
	// Header values must be ByteStrings: ASCII fallback for old clients, the real name as RFC 5987.
	const fallback = cleaned.replace(/[^\x20-\x7e]/g, "_").replace(/["\\%]/g, "_");
	const encoded = encodeURIComponent(cleaned).replace(/['()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
	return `${inline ? "inline" : "attachment"}; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

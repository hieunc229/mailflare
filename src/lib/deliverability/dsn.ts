/** Reads the first 256 KiB of a returned message; real delivery reports are a few KB. */
export const MAX_DSN_BYTES = 256 * 1024;

export type DsnRecipient = { finalRecipient: string; action: string; status: string; diagnostic: string };
export type DeliveryStatus = { originalMessageId: string | null; recipients: DsnRecipient[] };

type Part = { headers: Map<string, string>; body: string };

function splitPart(text: string): Part {
	const match = /\r?\n\r?\n/.exec(text);
	const head = match ? text.slice(0, match.index) : text;
	const body = match ? text.slice(match.index + match[0].length) : "";
	return { headers: parseHeaders(head), body };
}

function parseHeaders(head: string): Map<string, string> {
	const headers = new Map<string, string>();
	// Unfold continuation lines, then keep the first value of each name.
	for (const line of head.replace(/\r?\n[ \t]+/g, " ").split(/\r?\n/)) {
		const colon = line.indexOf(":");
		if (colon <= 0) continue;
		const name = line.slice(0, colon).trim().toLowerCase();
		if (!headers.has(name)) headers.set(name, line.slice(colon + 1).trim());
	}
	return headers;
}

function contentTypeParam(value: string, name: string): string | null {
	const match = new RegExp(`${name}\\s*=\\s*(?:"([^"]*)"|([^;\\s]+))`, "i").exec(value);
	return match ? (match[1] ?? match[2] ?? null) : null;
}

/** A top-level multipart/report of type delivery-status (RFC 3464); null for any other message. */
export function parseDeliveryStatus(raw: ArrayBuffer): DeliveryStatus | null {
	const text = new TextDecoder("utf-8").decode(raw.byteLength > MAX_DSN_BYTES ? raw.slice(0, MAX_DSN_BYTES) : raw);
	const top = splitPart(text);
	const contentType = top.headers.get("content-type") ?? "";
	if (!/^multipart\/report/i.test(contentType) || contentTypeParam(contentType, "report-type")?.toLowerCase() !== "delivery-status") return null;
	const boundary = contentTypeParam(contentType, "boundary");
	if (!boundary) return null;

	const recipients: DsnRecipient[] = [];
	let originalMessageId: string | null = null;
	for (const chunk of top.body.split(`--${boundary}`).slice(1)) {
		if (chunk.startsWith("--")) break;
		const part = splitPart(chunk.replace(/^\r?\n/, ""));
		const type = (part.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
		if (type === "message/delivery-status") {
			for (const group of part.body.split(/\r?\n\r?\n/)) {
				const fields = parseHeaders(group);
				const finalRecipient = fields.get("final-recipient")?.replace(/^[^;]*;\s*/, "").trim();
				if (!finalRecipient) continue;
				recipients.push({
					finalRecipient,
					action: (fields.get("action") ?? "").toLowerCase(),
					status: fields.get("status") ?? "",
					diagnostic: fields.get("diagnostic-code") ?? "",
				});
			}
		} else if (type === "text/rfc822-headers" || type === "message/rfc822") {
			const id = splitPart(`${part.body}\r\n\r\n`).headers.get("message-id");
			const bare = id?.replace(/^<|>$/g, "").trim();
			if (bare && !originalMessageId) originalMessageId = bare;
		}
	}
	return recipients.length ? { originalMessageId, recipients } : null;
}

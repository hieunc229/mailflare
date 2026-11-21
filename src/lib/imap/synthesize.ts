import { parseEmailAddressParts, splitEmailAddressList } from "@/lib/email/address";

/**
 * Builds the full RFC 5322 message IMAP serves for a message that has no stored
 * raw MIME (outbound, imported and most draft rows): headers from the columns, the
 * bodies, and the attachments' bytes. IMAP needs stable bytes and sizes, so the
 * output depends only on the arguments: the Date is `created_at`, boundaries come
 * from the message id, and every body and attachment is base64 (the result is
 * 7-bit, CRLF only, apart from an address whose local part is not ASCII: RFC 6532
 * writes such a mailbox as UTF-8, and RFC 2047 does not allow an encoded word
 * inside an address).
 *
 * Row values are untrusted text (a subject typed through the API can hold line
 * breaks), so every header value is stripped of control characters before it is
 * written and attachment content types, names and ids are reduced to safe forms.
 * Nothing here can add a header or a MIME part the caller did not give.
 */
export type SynthRow = {
	id: string;
	fromAddr: string;
	toAddr: string;
	ccAddr: string | null;
	bccAddr: string | null;
	replyTo: string | null;
	subject: string | null;
	textBody: string | null;
	htmlBody: string | null;
	providerMessageId: string | null;
	inReplyTo: string | null;
	references: string | null;
	createdAt: Date;
};

export type SynthAttachment = {
	filename: string;
	contentType: string;
	disposition: "attachment" | "inline";
	contentId: string | null;
	bytes: Uint8Array;
};

const CRLF = "\r\n";
const FOLD_AT = 76;
/** RFC 5322 2.1.1: no line is longer than 998 octets. A word longer than this is cut into pieces that fold. */
const MAX_WORD = 900;
/** Display names and tokens longer than this are written as encoded words, which fold anywhere. */
const MAX_PLAIN_TOKEN = 120;
/** RFC 5321 4.5.3.1.3: a path is at most 256 octets, so a longer mailbox is not a mailbox. */
const MAX_MAILBOX = 254;
const MAX_ID_TOKEN = 400;
/** Bytes of UTF-8 per encoded word: 45 bytes are 60 base64 characters, 72 with the `=?UTF-8?B?` wrapper. */
const WORD_BYTES = 45;

/** Control characters become spaces, so a value stays on one header line. */
const plain = (value: string) => value.replace(/[\u0000-\u0008\u000a-\u001f\u007f]/g, " ").trim();
const isAscii = (value: string) => /^[\u0020-\u007e]*$/.test(value);
const base64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");
const wrapBase64 = (bytes: Uint8Array) => (base64(bytes).match(/.{1,76}/g) ?? []).join(CRLF);

/** RFC 2047 encoded words, split on character boundaries and folded onto continuation lines. */
function encodeWords(text: string): string {
	const words: string[] = [];
	let current: number[] = [];
	for (const char of text) {
		const bytes = [...new TextEncoder().encode(char)];
		if (current.length + bytes.length > WORD_BYTES) {
			words.push(current.length ? `=?UTF-8?B?${base64(Uint8Array.from(current))}?=` : "");
			current = [];
		}
		current.push(...bytes);
	}
	if (current.length) words.push(`=?UTF-8?B?${base64(Uint8Array.from(current))}?=`);
	return words.filter(Boolean).join(`${CRLF} `);
}

const longestWord = (value: string) => value.split(/\s+/).reduce((longest, word) => Math.max(longest, word.length), 0);

const text = (value: string | null | undefined) => {
	const cleaned = plain(value ?? "");
	return isAscii(cleaned) && longestWord(cleaned) <= MAX_PLAIN_TOKEN ? cleaned : encodeWords(cleaned);
};

/**
 * One header, folded at spaces so no line is much longer than FOLD_AT. A line break
 * inside the value (between encoded words) stays a fold. No line is empty or only
 * white space, and a word longer than MAX_WORD is cut so that no line passes 998.
 */
function header(name: string, value: string): string {
	const lines: string[] = [];
	let line = "";
	const flush = () => {
		if (line) lines.push(lines.length ? ` ${line}` : `${name}: ${line}`);
		line = "";
	};
	value.split(CRLF).forEach((logical, index) => {
		if (index) flush();
		for (const word of logical.split(/[ \t]+/).filter(Boolean)) {
			for (let at = 0; at < word.length; at += MAX_WORD) {
				const piece = word.slice(at, at + MAX_WORD);
				const used = (lines.length ? 1 : name.length + 2) + line.length;
				if (line && used + 1 + piece.length > FOLD_AT) {
					flush();
					line = piece;
				} else line = line ? `${line} ${piece}` : piece;
				if (piece.length === MAX_WORD) flush();
			}
		}
	});
	flush();
	return lines.length ? lines.join(CRLF) : `${name}:`;
}

const ATEXT = /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~\u0080-\uffff-]+(\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~\u0080-\uffff-]+)*$/;

/** The domain as ASCII (a non-ASCII name becomes its A-label), or null when it cannot be one. */
function asciiDomain(domain: string): string | null {
	if (/^\[[\u0021-\u005a\u005e-\u007e]+\]$/.test(domain)) return domain;
	if (isAscii(domain)) return /^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$/.test(domain) ? domain : null;
	try {
		const host = new URL(`http://${domain}`).hostname;
		return isAscii(host) && /^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$/.test(host) ? host : null;
	} catch {
		return null;
	}
}

/** `local@domain` as an addr-spec: a local part with specials such as `:` or `,` is quoted, a non-ASCII domain is punycode. Null when nothing valid remains. */
function mailboxOf(address: string): string | null {
	const cleaned = address.replace(/[<>\s"]/g, "");
	if (!cleaned || cleaned.length > MAX_MAILBOX) return null;
	const at = cleaned.lastIndexOf("@");
	const local = at >= 0 ? cleaned.slice(0, at) : cleaned;
	if (!local) return null;
	const quoted = ATEXT.test(local) ? local : `"${local.replace(/[\\"]/g, "\\$&")}"`;
	if (at < 0) return quoted;
	const domain = asciiDomain(cleaned.slice(at + 1));
	return domain ? `${quoted}@${domain}` : null;
}

function addressList(value: string | null): string {
	return splitEmailAddressList(value)
		.map((entry) => {
			const { name, address } = parseEmailAddressParts(plain(entry));
			const mailbox = mailboxOf(address);
			if (!mailbox) return "";
			const label = plain(name ?? "");
			if (!label) return mailbox;
			return `${isAscii(label) && label.length <= MAX_PLAIN_TOKEN ? `"${label.replace(/[\\"]/g, "\\$&")}"` : encodeWords(label)} <${mailbox}>`;
		})
		.filter(Boolean)
		.join(", ");
}

/** `<id>` with nothing inside that could end the token early; null when nothing usable is left. */
function messageIdToken(value: string | null | undefined): string | null {
	const inner = plain(value ?? "").replace(/^<|>$/g, "");
	return inner && inner.length <= MAX_ID_TOKEN && !/[\s<>]/.test(inner) ? `<${inner}>` : null;
}

const asciiName = (value: string) => plain(value).replace(/[^\u0020-\u007e]|["\\]/g, "_") || "attachment";
/** RFC 8187: everything outside attr-char is percent-encoded. */
const encodeChar = (char: string) => encodeURIComponent(char).replace(/['()*]/g, (mark) => `%${mark.charCodeAt(0).toString(16).toUpperCase()}`);
/** Characters of a parameter value that stay in the quoted fallback, and in one RFC 2231 segment (encoded). */
const MAX_FALLBACK = 100;
const SEGMENT = 80;

/** A parameter whose value is not plain ASCII, or is long, gets RFC 2231 segments (a character is never split), each short enough to fold. */
function nameParameter(parameter: string, value: string): string {
	const cleaned = plain(value);
	const fallback = `${parameter}="${asciiName(value).slice(0, MAX_FALLBACK)}"`;
	if (isAscii(cleaned) && cleaned.length <= MAX_FALLBACK) return fallback;
	const segments: string[] = [];
	let current = "";
	for (const char of cleaned) {
		const encoded = encodeChar(char);
		if (current.length + encoded.length > SEGMENT) {
			segments.push(current);
			current = "";
		}
		current += encoded;
	}
	segments.push(current);
	const extended = segments.length === 1 ? `${parameter}*=UTF-8''${segments[0]}` : segments.map((segment, index) => `${parameter}*${index}*=${index ? "" : "UTF-8''"}${segment}`).join(`;${CRLF} `);
	return `${fallback};${CRLF} ${extended}`;
}

/** Only a plain `type/subtype` survives; `message/*` and `multipart/*` would have to be 7-bit or structural, so they are sent as opaque data. */
function safeContentType(value: string): string {
	const type = plain(value).split(";")[0].trim().toLowerCase();
	if (type.length > MAX_FALLBACK || !/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(type) || /^(message|multipart)\//.test(type)) return "application/octet-stream";
	return type;
}

const part = (headers: string[], body: string) => `${headers.join(CRLF)}${CRLF}${CRLF}${body}`;

function textPart(type: string, content: string): string {
	const body = content.replace(/\r\n|\r|\n/g, CRLF);
	return part([`Content-Type: ${type}; charset=utf-8`, "Content-Transfer-Encoding: base64"], wrapBase64(new TextEncoder().encode(body)));
}

function attachmentPart(attachment: SynthAttachment, inline: boolean): string {
	const type = safeContentType(attachment.contentType);
	const contentId = messageIdToken(attachment.contentId);
	return part(
		[
			`Content-Type: ${type};${CRLF} ${nameParameter("name", attachment.filename)}`,
			"Content-Transfer-Encoding: base64",
			`Content-Disposition: ${inline ? "inline" : "attachment"};${CRLF} ${nameParameter("filename", attachment.filename)}`,
			...(contentId ? [`Content-ID: ${contentId}`] : []),
		],
		wrapBase64(attachment.bytes),
	);
}

/** A multipart body whose boundary cannot occur in its parts: they are base64, whose lines never start with `--`. */
function multipart(subtype: string, boundary: string, parts: string[]): { header: string; body: string } {
	return {
		header: `Content-Type: multipart/${subtype};${CRLF} boundary="${boundary}"`,
		body: `${parts.map((entry) => `--${boundary}${CRLF}${entry}${CRLF}`).join("")}--${boundary}--${CRLF}`,
	};
}

const entityOf = (multi: { header: string; body: string }) => part([multi.header], multi.body);

export function synthesizeMessage(row: SynthRow, attachments: SynthAttachment[], options: { hostname: string }): Uint8Array {
	const safeId = row.id.replace(/[^A-Za-z0-9_-]/g, "_");
	const host = options.hostname.replace(/[^A-Za-z0-9.-]/g, "") || "localhost";
	const related = row.htmlBody ? attachments.filter((attachment) => attachment.disposition === "inline" && messageIdToken(attachment.contentId)) : [];
	const loose = attachments.filter((attachment) => !related.includes(attachment));

	// The body entity (headers + content): text and HTML, with the HTML's inline images beside it.
	const htmlPart = textPart("text/html", row.htmlBody ?? "");
	const htmlWithImages = related.length ? multipart("related", `=_mf_${safeId}_r`, [htmlPart, ...related.map((attachment) => attachmentPart(attachment, true))]) : null;
	const htmlEntity = htmlWithImages ? entityOf(htmlWithImages) : htmlPart;
	const bodyEntity = row.textBody && row.htmlBody
		? entityOf(multipart("alternative", `=_mf_${safeId}_a`, [textPart("text/plain", row.textBody), htmlEntity]))
		: row.htmlBody ? htmlEntity : textPart("text/plain", row.textBody ?? "");
	const entity = loose.length
		? entityOf(multipart("mixed", `=_mf_${safeId}_m`, [bodyEntity, ...loose.map((attachment) => attachmentPart(attachment, false))]))
		: bodyEntity;

	const messageId = messageIdToken(row.providerMessageId) ?? `<${safeId}@${host}>`;
	const inReplyTo = messageIdToken(row.inReplyTo);
	const references = plain(row.references ?? "").split(/\s+/).map(messageIdToken).filter((token): token is string => token !== null);
	const date = row.createdAt.toUTCString().replace("GMT", "+0000");
	const replyTo = addressList(row.replyTo);
	const cc = addressList(row.ccAddr);
	const bcc = addressList(row.bccAddr);
	const headers = [
		header("Date", date),
		header("From", addressList(row.fromAddr)),
		header("To", addressList(row.toAddr)),
		...(cc ? [header("Cc", cc)] : []),
		...(bcc ? [header("Bcc", bcc)] : []),
		...(replyTo ? [header("Reply-To", replyTo)] : []),
		header("Subject", text(row.subject)),
		header("Message-ID", messageId),
		...(inReplyTo ? [header("In-Reply-To", inReplyTo)] : []),
		...(references.length ? [header("References", references.join(" "))] : []),
		"MIME-Version: 1.0",
	];
	return new TextEncoder().encode(`${headers.join(CRLF)}${CRLF}${entity}${CRLF}`);
}

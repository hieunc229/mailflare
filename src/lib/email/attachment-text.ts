import { and, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { messageAttachments } from "@/db/schema";
import { truncateUtf8 } from "@/lib/email/inbound-limits";

/**
 * Text pulled out of attachments so search can index it later (F52).
 *
 * Where extraction runs is deliberate. Parsing a PDF is unbounded CPU (the source
 * cap and page cap do not bound decompression), and a Worker request path has as
 * little as 10 ms of CPU on Free, so nothing on a request path parses inline:
 * `storeMessageAttachments` leaves rows at "none" and `getAttachmentText` fills
 * one in when its text is first asked for. Queue consumers — the inbound mail
 * consumer and import jobs, which have 30 s and up — pass `extractText: true`
 * and enrich the row as it is stored.
 */

/** Bytes of source file we are willing to parse. Larger files are skipped unread. */
export const MAX_EXTRACTION_SOURCE_BYTES = 5 * 1024 * 1024;
/**
 * Cap on the text stored per attachment. Text is cut on a UTF-8 boundary, so
 * the stored value never exceeds this many bytes; a value at the cap was
 * truncated and consumers must not treat it as the complete document.
 */
export const MAX_EXTRACTED_TEXT_BYTES = 256 * 1024;
/** Pages of a PDF we read at most: past this the text is the document's opening, not all of it. */
export const MAX_EXTRACTION_PDF_PAGES = 100;

/** "none" means extraction has not run yet, and is the state that makes a later read extract. */
export type AttachmentExtractStatus = "none" | "done" | "failed" | "skipped";

/** What parsing one attachment's bytes produced. Nothing is stored yet. */
export interface AttachmentExtraction {
	/** Never "none": a parse always reports an outcome. */
	status: Exclude<AttachmentExtractStatus, "none">;
	/** The extracted text, or null when the attachment was skipped, failed, or held no text. */
	text: string | null;
}

export interface AttachmentTextResult extends AttachmentExtraction {
	/**
	 * Whether `message_attachments` now holds a decided status for this
	 * attachment. When false the row is still "none" — the write failed — so a
	 * later `getAttachmentText` extracts again. Extraction itself can still have
	 * succeeded: `status` and `text` describe the bytes, `persisted` describes the
	 * row. A lost race (another reader recorded first) counts as persisted: the
	 * row is decided and `getAttachmentText` returns the stored value.
	 */
	persisted: boolean;
}

const utf8 = new TextDecoder("utf-8", { fatal: false });
const charsetPattern = /charset\s*=\s*"?([\w.:-]+)/i;

const ascii = (text: string): Uint8Array => {
	const bytes = new Uint8Array(text.length);
	for (let index = 0; index < text.length; index += 1) bytes[index] = text.charCodeAt(index);
	return bytes;
};
const STREAM_KEYWORD = ascii("stream");
const ENDSTREAM_KEYWORD = ascii("endstream");
const LENGTH_KEYWORD = ascii("/Length");
const WHITESPACE = new Set([0x00, 0x09, 0x0a, 0x0c, 0x0d, 0x20]);

/** The MIME type without its parameters, lowercased ("text/plain; charset=x" → "text/plain"). */
export function attachmentMimeType(contentType: string): string {
	return (contentType.split(";")[0] ?? "").trim().toLowerCase();
}

/** Whether extraction handles this content type at all: text/* or PDF. */
export function isExtractableContentType(contentType: string): boolean {
	const type = attachmentMimeType(contentType);
	return type === "application/pdf" || type.startsWith("text/");
}

/**
 * Decode text bytes with the charset the sender declared, falling back to
 * UTF-8. Bytes that are invalid in the chosen charset become U+FFFD instead of
 * throwing, so a mislabelled file still yields its readable part.
 */
function decodeText(bytes: Uint8Array, contentType: string): string {
	const charset = charsetPattern.exec(contentType)?.[1]?.toLowerCase();
	if (charset && charset !== "utf-8" && charset !== "utf8") {
		try {
			return new TextDecoder(charset, { fatal: false }).decode(bytes);
		} catch {
			// A charset label workerd does not implement decodes as UTF-8.
		}
	}
	return utf8.decode(bytes);
}

/**
 * NUL is not storable in a PostgreSQL text column and other control characters
 * carry no meaning for search, so they are dropped. Line endings are unified.
 */
function normalizeText(text: string): string {
	return text.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
}

/** Index of `needle` at or after `from`, or -1. Native `indexOf` skips to each candidate first byte. */
function findBytes(haystack: Uint8Array, needle: Uint8Array, from: number): number {
	const last = haystack.length - needle.length;
	let index = from;
	while (index <= last) {
		index = haystack.indexOf(needle[0], index);
		if (index < 0 || index > last) return -1;
		let offset = 1;
		while (offset < needle.length && haystack[index + offset] === needle[offset]) offset += 1;
		if (offset === needle.length) return index;
		index += 1;
	}
	return -1;
}

/** A direct `/Length` value in the dictionary that precedes a stream, or null when absent or indirect. */
function declaredStreamLength(bytes: Uint8Array, stream: number): number | null {
	let marker = findBytes(bytes, LENGTH_KEYWORD, Math.max(0, stream - 256));
	if (marker < 0) return null;
	// The dictionary's own /Length is the last one written before the keyword.
	for (let next = findBytes(bytes, LENGTH_KEYWORD, marker + LENGTH_KEYWORD.length); next >= 0 && next < stream; next = findBytes(bytes, LENGTH_KEYWORD, next + LENGTH_KEYWORD.length)) marker = next;
	let index = marker + LENGTH_KEYWORD.length;
	while (index < stream && WHITESPACE.has(bytes[index])) index += 1;
	let digits = "";
	while (index < stream && bytes[index] >= 0x30 && bytes[index] <= 0x39) {
		digits += String.fromCharCode(bytes[index]);
		index += 1;
	}
	if (!digits) return null;
	while (index < stream && WHITESPACE.has(bytes[index])) index += 1;
	// `/Length 12 0 R` points at another object; only a direct number can be checked here.
	if (index < stream && bytes[index] >= 0x30 && bytes[index] <= 0x39) return null;
	const value = Number(digits);
	return Number.isSafeInteger(value) ? value : null;
}

/** Whether the last byte before the keyword's line closes a dictionary (`>>`), as a real stream does. */
function followsDictionary(bytes: Uint8Array, stream: number): boolean {
	let index = stream - 1;
	while (index > 0 && WHITESPACE.has(bytes[index])) index -= 1;
	return index >= 1 && bytes[index] === 0x3e && bytes[index - 1] === 0x3e;
}

/**
 * Whether the file carries a stream shorter than its declared /Length, which is
 * what truncation leaves behind. pdf.js recovers from a content stream that
 * stops mid-way instead of failing, so without this check a truncated PDF is
 * stored as "done" with no text and never retried. Only a stream with a direct
 * /Length is judged: an indirect reference, an absent one, or a file that cannot
 * be scanned is left to pdf.js, so a false failure cannot cost a healthy
 * document its text. A stream that is longer than declared is not reported
 * either — that is a stale count, not lost data.
 */
function hasTruncatedStream(bytes: Uint8Array): boolean {
	let cursor = 0;
	while (true) {
		const stream = findBytes(bytes, STREAM_KEYWORD, cursor);
		if (stream < 0) return false;
		cursor = stream + STREAM_KEYWORD.length;
		// Page text and binary data can contain the word, so only a keyword that
		// closes a dictionary and starts the stream data is treated as one.
		if (!followsDictionary(bytes, stream)) continue;
		const after = bytes[stream + STREAM_KEYWORD.length];
		if (after !== 0x0a && after !== 0x0d) continue;
		const length = declaredStreamLength(bytes, stream);
		if (length === null) continue;
		const contentStart = stream + STREAM_KEYWORD.length + (after === 0x0d && bytes[stream + STREAM_KEYWORD.length + 1] === 0x0a ? 2 : 1);
		const end = findBytes(bytes, ENDSTREAM_KEYWORD, contentStart);
		// A declared length with no terminator at all: the file stops inside the stream.
		if (end < 0) return true;
		let actual = end - contentStart;
		// The EOL before `endstream` is not part of the data.
		while (actual > 0 && (bytes[contentStart + actual - 1] === 0x0a || bytes[contentStart + actual - 1] === 0x0d)) actual -= 1;
		// A couple of bytes of slack covers producers that miscount the EOL; a
		// stream that stops well short of its own length was cut off.
		if (actual + 2 < length) return true;
	}
}

/** Read a PDF's text page by page, stopping at the page cap. */
async function extractPdfText(bytes: Uint8Array): Promise<string> {
	// Loaded on demand: the parser is the largest dependency of this path and most attachments are not PDFs.
	const { getDocumentProxy } = await import("unpdf");
	// pdf.js takes ownership of the bytes it is handed and detaches the buffer, so
	// it gets a copy: the caller may still need its own (an outbound send reuses
	// the attachment array it stored). `stopAtErrors` makes it throw on data it
	// cannot parse instead of quietly returning whatever it could recover.
	const document = await getDocumentProxy(bytes.slice(), { stopAtErrors: true });
	try {
		const pageCount = Math.min(document.numPages, MAX_EXTRACTION_PDF_PAGES);
		const pages: string[] = [];
		for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
			const page = await document.getPage(pageNumber);
			const content = await page.getTextContent();
			let pageText = "";
			for (const item of content.items) {
				if (!("str" in item)) continue;
				pageText += item.str;
				if (item.hasEOL) pageText += "\n";
			}
			pages.push(pageText);
		}
		return pages.join("\n");
	} finally {
		// Releases the parser's worker and the copy handed to it.
		await document.loadingTask.destroy();
	}
}

/**
 * Extract the text of one attachment from its bytes. Pure and bounded: it reads
 * nothing else, never throws, and reports the outcome the caller should store.
 */
export async function extractAttachmentText(contentType: string, bytes: Uint8Array): Promise<AttachmentExtraction> {
	if (!isExtractableContentType(contentType)) return { status: "skipped", text: null };
	if (bytes.byteLength > MAX_EXTRACTION_SOURCE_BYTES) return { status: "skipped", text: null };
	const type = attachmentMimeType(contentType);
	try {
		if (type === "application/pdf" && hasTruncatedStream(bytes)) {
			console.warn("Attachment PDF has a truncated stream");
			return { status: "failed", text: null };
		}
		const text = truncateUtf8(normalizeText(type === "application/pdf" ? await extractPdfText(bytes) : decodeText(bytes, contentType)), MAX_EXTRACTED_TEXT_BYTES);
		// Whitespace-only text (an empty page, a PDF that is only images) is stored as done with no text.
		return { status: "done", text: text.trim() ? text : null };
	} catch (error) {
		// A corrupt or encrypted file fails extraction, not the ingest that carried it.
		console.warn(`Attachment text extraction failed for ${type}`, error);
		return { status: "failed", text: null };
	}
}

type PersistOutcome = "written" | "already-recorded" | "not-recorded";

/**
 * Record an outcome on a row that has not been extracted yet. The write is
 * conditional on `extract_status = 'none'`, so two concurrent first readers
 * cannot overwrite each other's result: the first write wins and the loser
 * reads it back instead of replacing it.
 */
async function recordExtraction(env: CloudflareEnv, attachmentId: string, extraction: AttachmentExtraction): Promise<PersistOutcome> {
	const db = getDb(env);
	const written = await db
		.update(messageAttachments)
		.set({ extractedText: extraction.text, extractStatus: extraction.status, extractedAt: new Date() })
		.where(and(eq(messageAttachments.id, attachmentId), eq(messageAttachments.extractStatus, "none")))
		.returning({ id: messageAttachments.id });
	return written.length > 0 ? "written" : "already-recorded";
}

async function persistExtraction(env: CloudflareEnv, attachmentId: string, extraction: AttachmentExtraction): Promise<PersistOutcome> {
	try {
		return await recordExtraction(env, attachmentId, extraction);
	} catch (error) {
		// The row stays "none" and the next read extracts again: nothing is lost but the work.
		console.warn(`Storing extracted attachment text failed for ${attachmentId}; the row stays none`, error);
		return "not-recorded";
	}
}

/**
 * Extract and record text for an attachment that is being stored by a queue
 * consumer (inbound mail, import jobs). It never throws: a parser or database
 * failure is recorded where it can be, and a row left at "none" is retried by
 * the next read rather than losing the attachment.
 */
export async function extractStoredAttachmentText(
	env: CloudflareEnv,
	attachment: { id: string; contentType: string; content: ArrayBuffer | Uint8Array },
): Promise<AttachmentTextResult> {
	let extraction: AttachmentExtraction;
	try {
		// Constructing the view throws on a buffer that is already detached.
		const bytes = attachment.content instanceof Uint8Array ? attachment.content : new Uint8Array(attachment.content);
		extraction = await extractAttachmentText(attachment.contentType, bytes);
	} catch (error) {
		console.warn(`Attachment text extraction threw for ${attachment.id}`, error);
		extraction = { status: "failed", text: null };
	}
	return { ...extraction, persisted: (await persistExtraction(env, attachment.id, extraction)) !== "not-recorded" };
}

/**
 * The text of an attachment, extracting it on first use: rows stored by a
 * request path (left at "none" on purpose) and rows written before extraction
 * existed. Returns null when the attachment does not exist.
 *
 * A database failure propagates rather than being reported as "no text"; this is
 * not on any ingest path, so a caller that cannot read the row learns of it.
 */
export async function getAttachmentText(env: CloudflareEnv, attachmentId: string): Promise<AttachmentTextResult | null> {
	const db = getDb(env);
	const columns = {
		id: messageAttachments.id,
		contentType: messageAttachments.contentType,
		size: messageAttachments.size,
		extractedText: messageAttachments.extractedText,
		extractStatus: messageAttachments.extractStatus,
		r2Key: messageAttachments.r2Key,
	};
	const [row] = await db.select(columns).from(messageAttachments).where(eq(messageAttachments.id, attachmentId)).limit(1);
	if (!row) return null;
	if (row.extractStatus !== "none") return { status: row.extractStatus, text: row.extractedText, persisted: true };

	let extraction: AttachmentExtraction;
	if (!isExtractableContentType(row.contentType)) {
		// Nothing to read: an unsupported type is decided without touching the object.
		extraction = { status: "skipped", text: null };
	} else if (row.size > MAX_EXTRACTION_SOURCE_BYTES) {
		extraction = { status: "skipped", text: null };
	} else {
		try {
			// Read at most one byte past the cap, so a row whose stored size is stale
			// still cannot make this buffer an oversize object.
			const object = await env.BUCKET.get(row.r2Key, { range: { offset: 0, length: MAX_EXTRACTION_SOURCE_BYTES + 1 } });
			if (!object) {
				console.warn(`Attachment object missing for ${attachmentId}`);
				extraction = { status: "failed", text: null };
			} else {
				extraction = await extractAttachmentText(row.contentType, new Uint8Array(await object.arrayBuffer()));
			}
		} catch (error) {
			console.warn(`Attachment text extraction threw for ${attachmentId}`, error);
			extraction = { status: "failed", text: null };
		}
	}

	const outcome = await persistExtraction(env, attachmentId, extraction);
	if (outcome === "written") return { ...extraction, persisted: true };
	if (outcome === "already-recorded") {
		// A concurrent reader recorded first: answer with the row's value, not this parse's.
		const [stored] = await db.select(columns).from(messageAttachments).where(eq(messageAttachments.id, attachmentId)).limit(1);
		if (stored && stored.extractStatus !== "none") return { status: stored.extractStatus, text: stored.extractedText, persisted: true };
	}
	return { ...extraction, persisted: false };
}

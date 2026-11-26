import { and, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { messageAttachments } from "@/db/schema";
import { truncateUtf8 } from "@/lib/email/inbound-limits";

/**
 * Text pulled out of attachments so search can index it later (F52).
 *
 * PDF extraction is lazy only — it never runs inline, not on a request and not
 * in a queue consumer. Parsing a PDF is unbounded CPU (the source cap and page
 * cap do not bound decompression), and a runtime CPU or memory kill cannot be
 * caught: in the delivery queue, a kill between the message insert and its
 * attachment writes leaves partial state that the retry skips, so mail delivery
 * must never wait on a parser. PDF rows therefore stay at "none" until
 * `getAttachmentText` runs.
 *
 * The same holds for whoever consumes `getAttachmentText` (F52): that call can
 * parse a PDF, so it must not be made from a request path. Give it an
 * enrichment job or another bounded context for PDF rows. The only work done
 * inline is a text/* decode — a bounded, allocation-only operation — and only
 * when a queue consumer asks for it (`storeMessageAttachments(..., { extractText: true })`).
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
	 * Whether this call could confirm that `message_attachments` holds a decided
	 * status for the attachment. `false` only means no decision was confirmed by
	 * this call — the write failed, the row may have been deleted, or another
	 * writer's value now stands — so it does not promise the row is still "none".
	 * Extraction itself can still have succeeded: `status` and `text` describe the
	 * bytes this call parsed, `persisted` describes what could be confirmed.
	 */
	persisted: boolean;
}

const utf8 = new TextDecoder("utf-8", { fatal: false });
const charsetPattern = /charset\s*=\s*"?([\w.:-]+)/i;

/** The MIME type without its parameters, lowercased ("text/plain; charset=x" → "text/plain"). */
export function attachmentMimeType(contentType: string): string {
	return (contentType.split(";")[0] ?? "").trim().toLowerCase();
}

/** Whether the type is text, which is the only kind this module ever parses inline. */
export function isTextAttachment(contentType: string): boolean {
	return attachmentMimeType(contentType).startsWith("text/");
}

/** Whether extraction handles this content type at all: text/* or PDF. */
export function isExtractableContentType(contentType: string): boolean {
	return isTextAttachment(contentType) || attachmentMimeType(contentType) === "application/pdf";
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

/** Read a PDF's text page by page, stopping at the page cap. */
async function extractPdfText(bytes: Uint8Array): Promise<string> {
	// Loaded on demand: the parser is the largest dependency of this path and most attachments are not PDFs.
	const { getDocumentProxy } = await import("unpdf");
	// pdf.js takes ownership of the buffer it is handed and detaches it, and the
	// caller may still need its own (an outbound send reuses the attachment array
	// it stored). `new Uint8Array` is the copy that holds for every accepted
	// input: a Node Buffer's slice() returns a view, not a copy. `stopAtErrors`
	// makes the parser throw on data it cannot parse instead of quietly returning
	// whatever it could recover.
	const document = await getDocumentProxy(new Uint8Array(bytes), { stopAtErrors: true });
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
 *
 * Corruption is judged by the parser alone. pdf.js recovers what it can from a
 * damaged stream, so a file whose structure still parses comes back "done" with
 * whatever text survived (possibly none) — it is not marked "failed" on a guess
 * about bytes that look wrong. A file it cannot parse at all is "failed".
 */
export async function extractAttachmentText(contentType: string, bytes: Uint8Array): Promise<AttachmentExtraction> {
	if (!isExtractableContentType(contentType)) return { status: "skipped", text: null };
	if (bytes.byteLength > MAX_EXTRACTION_SOURCE_BYTES) return { status: "skipped", text: null };
	// An empty file holds no text and is not damage.
	if (bytes.byteLength === 0) return { status: "done", text: null };
	const type = attachmentMimeType(contentType);
	try {
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
		// Nothing was confirmed: the row may still be "none" (and read again), or gone.
		console.warn(`Storing extracted attachment text failed for ${attachmentId}`, error);
		return "not-recorded";
	}
}

/**
 * Enrich an attachment while a queue consumer stores it. Only text/* is read
 * here — a decode with no parser — so a consumer's budget cannot be spent on
 * unbounded work; anything else is left at "none" for `getAttachmentText`
 * (see the module comment on why PDF must not run inline). Never throws.
 *
 * Returns null when the attachment was deliberately left for the lazy path.
 */
export async function extractInlineAttachmentText(
	env: CloudflareEnv,
	attachment: { id: string; contentType: string; content: ArrayBuffer | Uint8Array },
): Promise<AttachmentTextResult | null> {
	if (!isTextAttachment(attachment.contentType)) return null;
	let extraction: AttachmentExtraction;
	try {
		// A view, not a copy: decoding never takes ownership of the bytes.
		const bytes = attachment.content instanceof Uint8Array ? attachment.content : new Uint8Array(attachment.content);
		extraction = await extractAttachmentText(attachment.contentType, bytes);
	} catch (error) {
		// Constructing the view throws on a buffer that is already detached.
		console.warn(`Attachment text extraction threw for ${attachment.id}`, error);
		extraction = { status: "failed", text: null };
	}
	return { ...extraction, persisted: (await persistExtraction(env, attachment.id, extraction)) !== "not-recorded" };
}

/** Object metadata when a ranged read failed, so an empty file is not mistaken for damage. */
async function headQuietly(env: CloudflareEnv, r2Key: string) {
	try {
		return await env.BUCKET.head(r2Key);
	} catch {
		return null;
	}
}

/**
 * The text of an attachment, extracting it on first use: PDFs (which are never
 * extracted inline) and rows written before extraction existed.
 *
 * This can parse a PDF, so it must not be called from a request path — see the
 * module comment. A database failure propagates rather than being reported as
 * "no text": a caller that cannot read the row should learn of it. Returns null
 * when the attachment does not exist.
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
			// Some runtimes refuse a range read of an empty object. Confirm the size
			// before calling a healthy empty file damaged — without a second, unbounded read.
			const head = await headQuietly(env, row.r2Key);
			if (head && head.size === 0) {
				extraction = { status: "done", text: null };
			} else {
				console.warn(`Attachment text extraction threw for ${attachmentId}`, error);
				extraction = { status: "failed", text: null };
			}
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

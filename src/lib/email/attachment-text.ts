import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { messageAttachments } from "@/db/schema";
import { truncateUtf8 } from "@/lib/email/inbound-limits";

/**
 * Text pulled out of attachments so search can index it later. Extraction is
 * best effort: a row records what happened in `extract_status`, and a row still
 * at "none" is extracted the first time someone asks for its text.
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

/** "none" means extraction has not run yet. */
export type AttachmentExtractStatus = "none" | "done" | "failed" | "skipped";

export interface AttachmentTextResult {
	/** Never "none": a call to extract always reports an outcome. */
	status: Exclude<AttachmentExtractStatus, "none">;
	/** The extracted text, or null when the attachment was skipped or failed. */
	text: string | null;
}

const utf8 = new TextDecoder("utf-8", { fatal: false });
const charsetPattern = /charset\s*=\s*"?([\w.:-]+)/i;

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

/** Read a PDF's text page by page, stopping at the page cap. */
async function extractPdfText(bytes: Uint8Array): Promise<string> {
	// Loaded on demand: the PDF parser is the largest dependency of this path and
	// most attachments are not PDFs.
	const { getDocumentProxy } = await import("unpdf");
	const document = await getDocumentProxy(bytes);
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
		// Releases the parser's worker; without it a Worker isolate keeps the document's memory.
		await document.loadingTask.destroy();
	}
}

/**
 * Extract the text of one attachment from its bytes. Pure and bounded: it reads
 * nothing else, never throws, and reports the outcome the caller should store.
 */
export async function extractAttachmentText(
	contentType: string,
	bytes: Uint8Array,
): Promise<AttachmentTextResult> {
	if (!isExtractableContentType(contentType)) return { status: "skipped", text: null };
	if (bytes.byteLength > MAX_EXTRACTION_SOURCE_BYTES) return { status: "skipped", text: null };
	const type = attachmentMimeType(contentType);
	try {
		const text = truncateUtf8(normalizeText(type === "application/pdf" ? await extractPdfText(bytes) : decodeText(bytes, contentType)), MAX_EXTRACTED_TEXT_BYTES);
		// Whitespace-only text (an empty page, an image-only PDF) is stored as done with no text.
		return { status: "done", text: text.trim() ? text : null };
	} catch (error) {
		// A corrupt or encrypted file fails extraction, not the ingest that carried it.
		console.warn(`Attachment text extraction failed for ${type}`, error);
		return { status: "failed", text: null };
	}
}

async function storeExtraction(
	env: CloudflareEnv,
	attachmentId: string,
	result: AttachmentTextResult,
): Promise<void> {
	const db = getDb(env);
	await db
		.update(messageAttachments)
		.set({ extractedText: result.text, extractStatus: result.status, extractedAt: new Date() })
		.where(eq(messageAttachments.id, attachmentId));
}

/**
 * Extract and record text for an attachment that was just stored. Called from
 * the shared attachment writer, so it covers received mail and imports alike.
 * It never throws: a failed update leaves the row at "none", which the lazy
 * path retries rather than losing the attachment.
 */
export async function extractStoredAttachmentText(
	env: CloudflareEnv,
	attachment: { id: string; contentType: string; content: ArrayBuffer | Uint8Array },
): Promise<AttachmentTextResult> {
	const bytes = attachment.content instanceof Uint8Array ? attachment.content : new Uint8Array(attachment.content);
	let result: AttachmentTextResult;
	try {
		result = await extractAttachmentText(attachment.contentType, bytes);
	} catch (error) {
		console.warn(`Attachment text extraction threw for ${attachment.id}`, error);
		return { status: "failed", text: null };
	}
	try {
		await storeExtraction(env, attachment.id, result);
	} catch (error) {
		console.warn(`Storing extracted attachment text failed for ${attachment.id}`, error);
	}
	return result;
}

/**
 * The text of an attachment, extracting it on first use (rows stored before
 * extraction existed, or written by a path that skipped it). Returns null when
 * the attachment does not exist.
 */
export async function getAttachmentText(
	env: CloudflareEnv,
	attachmentId: string,
): Promise<AttachmentTextResult | null> {
	const db = getDb(env);
	const [row] = await db
		.select({
			id: messageAttachments.id,
			contentType: messageAttachments.contentType,
			extractedText: messageAttachments.extractedText,
			extractStatus: messageAttachments.extractStatus,
			r2Key: messageAttachments.r2Key,
		})
		.from(messageAttachments)
		.where(eq(messageAttachments.id, attachmentId))
		.limit(1);
	if (!row) return null;
	if (row.extractStatus !== "none") {
		return { status: row.extractStatus, text: row.extractedText };
	}

	let result: AttachmentTextResult;
	try {
		const object = await env.BUCKET.get(row.r2Key);
		if (!object) {
			console.warn(`Attachment object missing for ${attachmentId}`);
			result = { status: "failed", text: null };
		} else {
			result = await extractAttachmentText(row.contentType, new Uint8Array(await object.arrayBuffer()));
		}
	} catch (error) {
		console.warn(`Attachment text extraction threw for ${attachmentId}`, error);
		result = { status: "failed", text: null };
	}
	try {
		await storeExtraction(env, attachmentId, result);
	} catch (error) {
		// The caller still gets the text; a later call retries the write.
		console.warn(`Storing extracted attachment text failed for ${attachmentId}`, error);
	}
	return result;
}

import { and, eq, isNull } from "drizzle-orm";
import { getDb } from "@/db";
import { messageAttachments, messages } from "@/db/schema";
import { newId } from "@/lib/ids";
import { assessAttachmentRisk, inspectZipDirectory, locateZipDirectory, mergeRisks, type AttachmentRisk } from "@/lib/email/attachment-risk";
import { truncateUtf8 } from "@/lib/email/inbound-limits";
import { getMailboxAccessLevel } from "@/lib/mailboxes/access";
import type { SessionUser } from "@/lib/auth/types";
import type {
	AttachmentContent,
	AttachmentMetadata,
	StoredAttachment,
} from "./attachment-types";

export const MAX_ATTACHMENT_SIZE = 25_000_000;
export const MAX_TOTAL_ATTACHMENT_SIZE = 25_000_000;
export const MAX_ATTACHMENT_COUNT = 10;

export function decodeBase64Content(content: string): ArrayBuffer {
	const binary = atob(content.replace(/\s/g, ""));
	const bytes = new Uint8Array(binary.length);
	for (let index = 0; index < binary.length; index += 1) {
		bytes[index] = binary.charCodeAt(index);
	}
	return bytes.buffer;
}

export function normalizeAttachmentContent(
	content: ArrayBuffer | Uint8Array | string,
	encoding?: "base64" | "utf8",
): ArrayBuffer {
	if (content instanceof ArrayBuffer) return content;
	if (content instanceof Uint8Array) {
		return content.buffer.slice(content.byteOffset, content.byteOffset + content.byteLength) as ArrayBuffer;
	}
	if (encoding === "base64") return decodeBase64Content(content);
	return new TextEncoder().encode(content).buffer;
}

const MAX_FILENAME_BYTES = 180;

export function sanitizeFilename(filename: string): string {
	// Control and bidi characters are dropped so a name cannot reorder or hide its extension.
	// eslint-disable-next-line no-control-regex
	const normalized = filename.replace(/[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "").trim().replace(/[/\\]/g, "_");
	if (!normalized || /^\.+$/.test(normalized)) return "attachment";
	if (new TextEncoder().encode(normalized).byteLength <= MAX_FILENAME_BYTES) return normalized;
	// Keep a short extension so the file type survives truncation.
	const extension = normalized.match(/\.[A-Za-z0-9]{1,10}$/)?.[0] ?? "";
	return `${truncateUtf8(normalized.slice(0, normalized.length - extension.length), MAX_FILENAME_BYTES - extension.length)}${extension}`;
}

export function validateAttachments(attachments: AttachmentContent[]): void {
	if (attachments.length > MAX_ATTACHMENT_COUNT) {
		throw new Error(`A message can include at most ${MAX_ATTACHMENT_COUNT} attachments`);
	}

	let totalSize = 0;
	for (const attachment of attachments) {
		const size = attachment.content.byteLength;
		if (size > MAX_ATTACHMENT_SIZE) {
			throw new Error(`${attachment.filename} exceeds the 25 MB attachment limit`);
		}
		totalSize += size;
	}

	if (totalSize > MAX_TOTAL_ATTACHMENT_SIZE) {
		throw new Error("Attachments exceed the 25 MB total limit");
	}
}

export async function storeMessageAttachments(
	env: CloudflareEnv,
	messageId: string,
	attachments: AttachmentContent[],
	options?: { validate?: boolean },
): Promise<StoredAttachment[]> {
	if (options?.validate !== false) validateAttachments(attachments);
	const db = getDb(env);
	const stored: StoredAttachment[] = [];

	try {
		for (const attachment of attachments) {
			const id = newId("att");
			const filename = sanitizeFilename(attachment.filename);
			const r2Key = `attachments/${messageId}/${id}/${filename}`;
			const disposition = attachment.disposition ?? "attachment";

			await env.BUCKET.put(r2Key, attachment.content, {
				httpMetadata: { contentType: attachment.type },
				customMetadata: { filename, messageId },
			});
			stored.push({
				id,
				messageId,
				filename,
				type: attachment.type,
				size: attachment.content.byteLength,
				disposition,
				contentId: attachment.contentId ?? null,
				r2Key,
			});
			await db.insert(messageAttachments).values({
				id,
				messageId,
				filename,
				contentType: attachment.type,
				size: attachment.content.byteLength,
				disposition,
				contentId: attachment.contentId ?? null,
				r2Key,
			});
		}
	} catch (error) {
		await Promise.all(stored.map((attachment) => env.BUCKET.delete(attachment.r2Key)));
		throw error;
	}

	return stored;
}

/**
 * Duplicate a message's attachments onto another message (a forward draft).
 * R2 keys are unique per row, so the objects are copied rather than shared,
 * which keeps deleting the draft from touching the original.
 */
export async function copyMessageAttachments(
	env: CloudflareEnv,
	fromMessageId: string,
	toMessageId: string,
): Promise<AttachmentMetadata[]> {
	const db = getDb(env);
	const rows = await db.select().from(messageAttachments).where(and(eq(messageAttachments.messageId, fromMessageId), isNull(messageAttachments.trashedAt)));
	const copied: AttachmentMetadata[] = [];
	for (const row of rows) {
		const object = await env.BUCKET.get(row.r2Key);
		if (!object) continue;
		const id = newId("att");
		const r2Key = `attachments/${toMessageId}/${id}/${sanitizeFilename(row.filename)}`;
		await env.BUCKET.put(r2Key, await object.arrayBuffer(), {
			httpMetadata: { contentType: row.contentType },
			customMetadata: { filename: row.filename, messageId: toMessageId },
		});
		await db.insert(messageAttachments).values({
			id,
			messageId: toMessageId,
			filename: row.filename,
			contentType: row.contentType,
			size: row.size,
			disposition: row.disposition,
			contentId: row.contentId,
			r2Key,
		});
		copied.push({
			id,
			messageId: toMessageId,
			filename: row.filename,
			type: row.contentType,
			size: row.size,
			disposition: row.disposition as "attachment" | "inline",
			contentId: row.contentId,
		});
	}
	return copied;
}

/** Attachments with their bytes, for handing a draft's files to the send path. */
export async function loadMessageAttachmentContents(
	env: CloudflareEnv,
	messageId: string,
): Promise<AttachmentContent[]> {
	const db = getDb(env);
	const rows = await db.select().from(messageAttachments).where(and(eq(messageAttachments.messageId, messageId), isNull(messageAttachments.trashedAt)));
	const result: AttachmentContent[] = [];
	for (const row of rows) {
		const object = await env.BUCKET.get(row.r2Key);
		if (!object) continue;
		result.push({
			storageId: row.id,
			filename: row.filename,
			type: row.contentType,
			content: await object.arrayBuffer(),
			disposition: row.disposition as "attachment" | "inline",
			contentId: row.contentId,
		});
	}
	return result;
}

/** Remove one attachment (row and object). Returns false when it is not on that message. */
export async function deleteMessageAttachment(
	env: CloudflareEnv,
	messageId: string,
	attachmentId: string,
): Promise<boolean> {
	const db = getDb(env);
	const [row] = await db
		.select({ r2Key: messageAttachments.r2Key })
		.from(messageAttachments)
		.where(and(eq(messageAttachments.id, attachmentId), eq(messageAttachments.messageId, messageId)))
		.limit(1);
	if (!row) return false;
	await db.delete(messageAttachments).where(eq(messageAttachments.id, attachmentId));
	await env.BUCKET.delete(row.r2Key);
	return true;
}

/** Remove every attachment object of a message; the rows cascade with the message row. */
export async function deleteMessageAttachmentObjects(env: CloudflareEnv, messageId: string): Promise<void> {
	const db = getDb(env);
	const rows = await db
		.select({ r2Key: messageAttachments.r2Key })
		.from(messageAttachments)
		.where(eq(messageAttachments.messageId, messageId));
	await Promise.all(rows.map((row) => env.BUCKET.delete(row.r2Key)));
}

export async function listMessageAttachments(
	env: CloudflareEnv,
	messageId: string,
): Promise<AttachmentMetadata[]> {
	const db = getDb(env);
	const rows = await db
		.select()
		.from(messageAttachments)
		.where(and(eq(messageAttachments.messageId, messageId), isNull(messageAttachments.trashedAt)));

	return rows.map((attachment) => ({
		id: attachment.id,
		messageId: attachment.messageId,
		filename: attachment.filename,
		type: attachment.contentType,
		size: attachment.size,
		disposition: attachment.disposition as "attachment" | "inline",
		contentId: attachment.contentId,
	}));
}

export async function getAttachmentForUser(
	env: CloudflareEnv,
	user: SessionUser,
	messageId: string,
	attachmentId: string,
) {
	const db = getDb(env);
	const [message] = await db.select().from(messages).where(eq(messages.id, messageId)).limit(1);
	if (!message) return null;

	if (message.mailboxId) {
		const access = await getMailboxAccessLevel(db, user, message.mailboxId);
		if (!access?.canRead) return null;
	} else if (message.userId !== user.id) {
		return null;
	}

	const [attachment] = await db
		.select()
		.from(messageAttachments)
		.where(
			and(
				eq(messageAttachments.id, attachmentId),
				eq(messageAttachments.messageId, messageId),
				isNull(messageAttachments.trashedAt),
			),
		)
		.limit(1);
	if (!attachment) return null;

	const object = await env.BUCKET.get(attachment.r2Key);
	if (!object) return null;
	return { attachment, object };
}

/**
 * Name-based risk plus, for ZIP files, the names inside the archive (read with two bounded range
 * requests, never extracted). Used before a download and to label attachments in the reader.
 */
export async function assessStoredAttachment(env: CloudflareEnv, attachment: { filename: string; type: string; size: number; r2Key: string }): Promise<AttachmentRisk> {
	const byName = assessAttachmentRisk(attachment);
	const isZip = /\.zip$/i.test(attachment.filename) || attachment.type === "application/zip" || attachment.type === "application/x-zip-compressed";
	if (!isZip || attachment.size < 22) return byName;
	try {
		const tailObject = await env.BUCKET.get(attachment.r2Key, { range: { suffix: Math.min(attachment.size, 65_557) } });
		if (!tailObject) return byName;
		const tail = new Uint8Array(await tailObject.arrayBuffer());
		const located = locateZipDirectory(tail);
		if (!located) return byName;
		let directory: Uint8Array | null = null;
		if (located.size > 0 && located.size <= 1024 * 1024 && located.offset + located.size <= attachment.size) {
			const object = await env.BUCKET.get(attachment.r2Key, { range: { offset: located.offset, length: located.size } });
			if (object) directory = new Uint8Array(await object.arrayBuffer());
		}
		return mergeRisks(byName, inspectZipDirectory(tail, () => directory));
	} catch {
		return mergeRisks(byName, { level: "warning", reasons: ["This archive could not be checked."] });
	}
}

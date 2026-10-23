import { and, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { messages } from "@/db/schema";
import { storeMessageAttachments } from "@/lib/email/attachments";
import { deleteMessageWithObjects } from "@/lib/email/message-cleanup";
import { buildSnippet, parseRawMime } from "@/lib/email/parse";
import { resolveThreadId } from "@/lib/email/threading";
import { upsertContactFromAddress } from "@/lib/contacts/service";
import { newId } from "@/lib/ids";
import { getImportMessagePlacement } from "./destination";
import type { ImportDestination } from "./destination-types";
import type { ImportMailboxResult, ImportMessageInput } from "./types";

export async function importMessagesToMailbox(
	env: CloudflareEnv,
	input: {
		userId: string;
		mailboxId: string;
		destination: ImportDestination;
		messages: ImportMessageInput[];
	},
): Promise<ImportMailboxResult> {
	const result: ImportMailboxResult = { imported: 0, skipped: 0, errors: [] };
	for (const message of input.messages) {
		try {
			const imported = await importMessageToMailbox(env, {
				userId: input.userId,
				mailboxId: input.mailboxId,
				destination: input.destination,
				filename: message.filename,
				raw: message.raw,
				read: message.read,
				starred: message.starred,
			});
			if (imported) {
				result.imported += 1;
			} else {
				result.skipped += 1;
			}
		} catch (error) {
			result.skipped += 1;
			result.errors.push(`${message.filename}: ${error instanceof Error ? error.message : "Import failed"}`);
		}
	}
	return result;
}

async function importMessageToMailbox(
	env: CloudflareEnv,
	input: {
		userId: string;
		mailboxId: string;
		destination: ImportDestination;
		filename: string;
		raw: ArrayBuffer;
		read?: boolean;
		starred?: boolean;
	},
): Promise<boolean> {
	const parsed = await parseRawMime(input.raw);
	const db = getDb(env);
	const providerMessageId = parsed.messageId ?? `import:${input.filename}:${input.raw.byteLength}`;

	const [existing] = await db
		.select({ id: messages.id, read: messages.read, starred: messages.starred })
		.from(messages)
		.where(and(eq(messages.mailboxId, input.mailboxId), eq(messages.providerMessageId, providerMessageId)))
		.limit(1);
	if (existing) {
		// Re-imports only add read/starred state, so local changes are never undone.
		const read = existing.read || input.read === true;
		const starred = existing.starred || input.starred === true;
		if (read !== existing.read || starred !== existing.starred) {
			await db.update(messages).set({ read, starred }).where(eq(messages.id, existing.id));
		}
		return false;
	}

	const messageId = newId("msg");
	const rawR2Key = `imports/${messageId}.eml`;
	const fromAddr = parsed.fromAddr ?? "unknown";
	const toAddr = parsed.toAddr ?? "";
	const createdAt = parsed.date ?? new Date();
	const placement = getImportMessagePlacement(input.destination);

	await db.insert(messages).values({
		id: messageId,
		userId: input.userId,
		mailboxId: input.mailboxId,
		folderId: placement.folderId,
		direction: placement.direction,
		providerMessageId,
		fromAddr,
		toAddr,
		ccAddr: parsed.ccAddr,
		replyTo: parsed.replyTo,
		subject: parsed.subject,
		snippet: buildSnippet(parsed.text, parsed.html),
		textBody: parsed.text,
		htmlBody: parsed.html,
		rawR2Key,
		status: placement.status,
		read: input.read ?? placement.direction === "outbound",
		starred: input.starred ?? false,
		threadId: await resolveThreadId(db, {
			mailboxId: input.mailboxId,
			messageId: parsed.messageId,
			inReplyTo: parsed.inReplyTo,
			references: parsed.references,
		}),
		inReplyTo: parsed.inReplyTo,
		references: parsed.references.length ? parsed.references.join(" ") : null,
		createdAt,
	});

	try {
		await env.BUCKET.put(rawR2Key, input.raw, {
			httpMetadata: { contentType: "message/rfc822" },
		});
		await storeMessageAttachments(env, messageId, parsed.attachments, { validate: false });
		const contactAddress = placement.direction === "outbound" ? toAddr : fromAddr;
		await upsertContactFromAddress(env, {
			userId: input.userId,
			address: contactAddress,
			source: placement.direction === "outbound" ? "outbound" : "inbound",
		});
	} catch (error) {
		await deleteMessageWithObjects(env, db, messageId, rawR2Key);
		throw error;
	}

	return true;
}

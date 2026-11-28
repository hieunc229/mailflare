import { and, eq, inArray } from "drizzle-orm";
import { getDb } from "@/db";
import { messages } from "@/db/schema";
import { storeMessageAttachments } from "@/lib/email/attachments";
import { deleteMessageWithObjects } from "@/lib/email/message-cleanup";
import { buildSnippet, parseRawMime } from "@/lib/email/parse";
import { resolveThreadId } from "@/lib/email/threading";
import { upsertContactsFromAddresses } from "@/lib/contacts/service";
import { selectInBatches } from "@/lib/db-params";
import { normalizeEmailAddress } from "@/lib/email/address";
import { newId } from "@/lib/ids";
import { getImportMessagePlacement } from "./destination";
import type { ImportDestination } from "./destination-types";
import { applyImportHints, getImportMessageHints } from "./message-hints-utils";
import type { ImportMailboxResult, ImportMessageInput } from "./types";

type ParsedMail = Awaited<ReturnType<typeof parseRawMime>>;
type KnownMessage = { id: string; read: boolean; starred: boolean };
type ImportContact = { address: string; source: "inbound" | "outbound"; seenAt: Date };

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
	const db = getDb(env);

	const parsedMessages: Array<{ message: ImportMessageInput; parsed: ParsedMail; providerMessageId: string }> = [];
	for (const message of input.messages) {
		try {
			const parsed = await parseRawMime(message.raw);
			parsedMessages.push({ message, parsed, providerMessageId: parsed.messageId ?? `import:${message.filename}:${message.raw.byteLength}` });
		} catch (error) {
			result.skipped += 1;
			result.errors.push(`${message.filename}: ${describeImportError(error)}`);
		}
	}

	// One lookup for the whole chunk instead of one per message.
	const known = new Map<string, KnownMessage>();
	const rows = await selectInBatches(parsedMessages.map((entry) => entry.providerMessageId), (batch) => db
		.select({ id: messages.id, providerMessageId: messages.providerMessageId, read: messages.read, starred: messages.starred })
		.from(messages)
		.where(and(eq(messages.mailboxId, input.mailboxId), inArray(messages.providerMessageId, batch))));
	for (const row of rows) if (row.providerMessageId) known.set(row.providerMessageId, row);

	const contactEntries: ImportContact[] = [];
	for (const { message, parsed, providerMessageId } of parsedMessages) {
		try {
			const existing = known.get(providerMessageId);
			if (existing) {
				// Re-imports only add read/starred state, so local changes are never undone.
				const read = existing.read || message.read === true;
				const starred = existing.starred || message.starred === true;
				if (read !== existing.read || starred !== existing.starred) {
					await db.update(messages).set({ read, starred }).where(eq(messages.id, existing.id));
					known.set(providerMessageId, { ...existing, read, starred });
				}
				result.skipped += 1;
				continue;
			}
			const stored = await importParsedMessage(env, db, { ...input, filename: message.filename, raw: message.raw, read: message.read, starred: message.starred }, parsed, providerMessageId);
			known.set(providerMessageId, { id: stored.id, read: stored.read, starred: stored.starred });
			if (stored.contact) contactEntries.push(stored.contact);
			result.imported += 1;
		} catch (error) {
			result.skipped += 1;
			result.errors.push(`${message.filename}: ${describeImportError(error)}`);
		}
	}

	await upsertImportContacts(env, input.userId, contactEntries);
	return result;
}

/** The contact is a by-product: the messages are already stored, so a failed update must not discard them. One write per direction. */
async function upsertImportContacts(env: CloudflareEnv, userId: string, entries: ImportContact[]): Promise<void> {
	for (const source of ["inbound", "outbound"] as const) {
		const group = entries.filter((entry) => entry.source === source);
		if (!group.length) continue;
		const seenAt = new Map<string, Date>();
		for (const { address, seenAt: date } of group) {
			const email = normalizeEmailAddress(address);
			if (!email) continue;
			const current = seenAt.get(email);
			if (!current || date > current) seenAt.set(email, date);
		}
		// No Gravatar lookup per imported sender; the avatar is fetched when mail from them next arrives.
		await upsertContactsFromAddresses(env, userId, group.map((entry) => entry.address), source, { seenAt, lookupAvatar: false })
			.catch((error) => console.error("Import contact update failed", describeImportError(error)));
	}
}

async function importParsedMessage(
	env: CloudflareEnv,
	db: ReturnType<typeof getDb>,
	input: {
		userId: string;
		mailboxId: string;
		destination: ImportDestination;
		filename: string;
		raw: ArrayBuffer;
		read?: boolean;
		starred?: boolean;
	},
	parsed: ParsedMail,
	providerMessageId: string,
): Promise<{ id: string; read: boolean; starred: boolean; contact: ImportContact | null }> {
	const messageId = newId("msg");
	const rawR2Key = `imports/${messageId}.eml`;
	const fromAddr = parsed.fromAddr ?? "unknown";
	const toAddr = parsed.toAddr ?? "";
	const createdAt = parsed.date ?? new Date();
	const hints = getImportMessageHints(input.raw);
	const placement = getImportMessagePlacement(applyImportHints(input.destination, hints));
	const read = input.read ?? hints.read ?? placement.direction === "outbound";
	const starred = input.starred ?? hints.starred ?? false;

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
		privateDraft: placement.status === "draft",
		read,
		starred,
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
	} catch (error) {
		await deleteMessageWithObjects(env, db, messageId, rawR2Key);
		throw error;
	}

	const address = placement.direction === "outbound" ? toAddr : fromAddr;
	return { id: messageId, read, starred, contact: { address, source: placement.direction === "outbound" ? "outbound" : "inbound", seenAt: createdAt } };
}

/**
 * Drizzle wraps driver errors as "Failed query: <sql> params: <values>", which
 * hides the reason and repeats message data; the driver's own message is on `cause`.
 */
export function describeImportError(error: unknown): string {
	if (!(error instanceof Error)) return "Import failed";
	return error.cause instanceof Error && error.message.startsWith("Failed query") ? error.cause.message : error.message;
}

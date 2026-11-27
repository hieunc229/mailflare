import { and, asc, eq, getTableColumns, inArray, isNull, ne, notInArray, or } from "drizzle-orm";
import { getDb } from "@/db";
import { messageAttachments, messages } from "@/db/schema";
import { getContactCardMap } from "@/lib/contacts/service";
import { getPartyDisplayName } from "@/lib/contacts/utils";
import { getFirstEmailAddressEntry, normalizeEmailAddress } from "@/lib/email/address";
import { draftsVisibleTo, isOthersDraft } from "@/lib/email/draft-access";
import { getMailboxAccessLevel } from "@/lib/mailboxes/access";
import type { SessionUser } from "@/lib/auth/types";

/**
 * The conversation a message belongs to: every stored message in the same
 * mailbox sharing its thread id, oldest first. Drafts and trashed messages are
 * left out, matching what threaded clients show. Bodies come along so the
 * reader can expand any message without another round trip. Callers that
 * fetch bodies one at a time (`GET /api/messages/{id}`) pass `bodies: "none"`
 * to skip the text and HTML columns entirely; those rows carry
 * `bodyOmitted: true` so a client can tell "not loaded" from "empty".
 */
export type ThreadBodies = "all" | "none";

/** The R2 key is an internal pointer and never leaves the server. */
function withoutRawKey<T extends { rawR2Key: string | null }>(row: T): Omit<T, "rawR2Key"> {
	const copy: Partial<T> = { ...row };
	delete copy.rawR2Key;
	return copy as Omit<T, "rawR2Key">;
}

type MessageRow = typeof messages.$inferSelect;
type ThreadRow = Omit<MessageRow, "textBody" | "htmlBody"> & Partial<Pick<MessageRow, "textBody" | "htmlBody">>;

export async function getMessageThreadForUser(env: CloudflareEnv, user: SessionUser, messageId: string, options: { bodies?: ThreadBodies } = {}) {
	const omitBodies = options.bodies === "none";
	const db = getDb(env);
	const { textBody: _text, htmlBody: _html, ...metadataColumns } = getTableColumns(messages);
	void _text;
	void _html;
	// Without bodies the heavy columns are never read from the database.
	const selectRows = () => (omitBodies ? db.select(metadataColumns).from(messages) : db.select().from(messages));
	const [message] = await db
		.select({ mailboxId: messages.mailboxId, userId: messages.userId, threadId: messages.threadId, status: messages.status, privateDraft: messages.privateDraft })
		.from(messages)
		.where(eq(messages.id, messageId))
		.limit(1);
	if (!message?.mailboxId || isOthersDraft(message, user.id)) return null;
	const access = await getMailboxAccessLevel(db, user, message.mailboxId);
	if (!access?.canRead) return null;

	const rows: ThreadRow[] = message.threadId
		? await selectRows()
				.where(
					and(
						eq(messages.mailboxId, message.mailboxId),
						eq(messages.threadId, message.threadId),
						notInArray(messages.status, ["draft", "trash"]),
						// Another user's draft filed under Archive or a folder is still their private draft.
						draftsVisibleTo(user.id),
						// Spam stays out of a conversation unless it is the message being opened.
						or(ne(messages.status, "spam"), eq(messages.id, messageId)),
					),
				)
				.orderBy(asc(messages.createdAt))
				.limit(200)
		: await selectRows().where(eq(messages.id, messageId)).limit(1);

	const ids = rows.map((row) => row.id);
	const attachmentQuery = ids.length ? listThreadAttachments(db, ids) : null;
	const [attachmentRows, contactMap] = await Promise.all([
		attachmentQuery ?? Promise.resolve([]),
		getContactCardMap(
			env,
			message.userId,
			rows.flatMap((row) => [row.fromAddr, getFirstEmailAddressEntry(row.toAddr)]),
		),
	]);
	const attachmentsByMessage = new Map<string, typeof attachmentRows>();
	for (const attachment of attachmentRows) {
		const list = attachmentsByMessage.get(attachment.messageId) ?? [];
		list.push(attachment);
		attachmentsByMessage.set(attachment.messageId, list);
	}

	return {
		threadId: message.threadId,
		messages: rows.map((row) => {
			const contact = contactMap.get(normalizeEmailAddress(row.fromAddr));
			const firstTo = getFirstEmailAddressEntry(row.toAddr);
			return {
				...withoutRawKey(row),
				...(omitBodies ? { textBody: null, htmlBody: null, bodyOmitted: true } : {}),
				// The reader already fetched the open message; its thread copy does not need the body again.
				...(row.id === messageId ? { textBody: null, htmlBody: null } : {}),
				fromContactName: getPartyDisplayName(row.fromAddr, contact),
				fromContactHasAvatar: contact?.hasAvatar ?? false,
				toContactName: getPartyDisplayName(firstTo, contactMap.get(normalizeEmailAddress(firstTo))),
				attachments: attachmentsByMessage.get(row.id) ?? [],
			};
		}),
	};
}

// D1 caps bound parameters per statement at 100 and a thread can hold up to 200 messages.
const ATTACHMENT_ID_CHUNK = 90;

/** Attachments for the given messages, queried in chunks that fit D1's parameter limit. */
async function listThreadAttachments(db: ReturnType<typeof getDb>, ids: string[]) {
	const chunks: string[][] = [];
	for (let offset = 0; offset < ids.length; offset += ATTACHMENT_ID_CHUNK) chunks.push(ids.slice(offset, offset + ATTACHMENT_ID_CHUNK));
	const results = await Promise.all(chunks.map((chunk) => db
		.select({
			id: messageAttachments.id,
			messageId: messageAttachments.messageId,
			filename: messageAttachments.filename,
			type: messageAttachments.contentType,
			size: messageAttachments.size,
			disposition: messageAttachments.disposition,
			contentId: messageAttachments.contentId,
		})
		.from(messageAttachments)
		.where(and(inArray(messageAttachments.messageId, chunk), isNull(messageAttachments.trashedAt)))));
	return results.flat();
}

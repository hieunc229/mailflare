import { and, desc, eq, inArray, isNotNull, isNull, notInArray } from "drizzle-orm";
import { getDb } from "@/db";
import { messageAttachments, messages } from "@/db/schema";
import { DRAFT_FILTER_PARAMS, draftsVisibleTo } from "@/lib/email/draft-access";
import { hasMailboxPermission, listAccessibleMailboxes } from "@/lib/mailboxes/access";
import { driveTypesCondition } from "./categories";
import type { DriveCategory } from "./categories";
import type { DriveItemDto } from "./types";

type Db = ReturnType<typeof getDb>;
const MAX_ATTACHMENTS = 500;
// Each statement also binds the attachment, type and draft-filter parameters; D1 allows 100 in all.
const MAILBOX_CHUNK = 80 - DRAFT_FILTER_PARAMS;

function senderName(from: string): string {
	const named = from.match(/^\s*"?([^"<]+?)"?\s*<[^>]+>\s*$/)?.[1];
	return (named ?? from).trim();
}

/**
 * Files attached to mail the user can read, received or sent. Inline images, drafts (including other users' drafts filed elsewhere), trash and spam are left out. With `trashed`, lists the attachments in the Drive trash instead.
 * Deleting needs more than read-only access to the mailbox. The attachment's own id is the item id; it is opened through `/api/drive/attachments/<id>/content`.
 */
export async function listDriveAttachments(db: Db, user: Parameters<typeof listAccessibleMailboxes>[1], categories: DriveCategory[], trashed = false): Promise<DriveItemDto[]> {
	const accessible = await listAccessibleMailboxes(db, user);
	const mailboxIds = accessible.map((mailbox) => mailbox.id);
	const permissions = new Map(accessible.map((mailbox) => [mailbox.id, mailbox.permission]));
	const scopes = [and(isNull(messages.mailboxId), eq(messages.userId, user.id))];
	for (let index = 0; index < mailboxIds.length; index += MAILBOX_CHUNK) scopes.push(inArray(messages.mailboxId, mailboxIds.slice(index, index + MAILBOX_CHUNK)));
	const typeFilter = categories.length ? [driveTypesCondition(categories, { contentType: messageAttachments.contentType, name: messageAttachments.filename })] : [];

	const fetchScope = (scope: ReturnType<typeof and>) => db
		.select({ attachment: messageAttachments, messageId: messages.id, subject: messages.subject, from: messages.fromAddr, direction: messages.direction, mailboxId: messages.mailboxId, date: messages.createdAt })
		.from(messageAttachments)
		.innerJoin(messages, eq(messageAttachments.messageId, messages.id))
		.where(and(scope, eq(messageAttachments.disposition, "attachment"), trashed ? isNotNull(messageAttachments.trashedAt) : isNull(messageAttachments.trashedAt), notInArray(messages.status, ["draft", "trash", "spam"]), draftsVisibleTo(user.id), ...typeFilter))
		.orderBy(desc(messages.createdAt))
		.limit(MAX_ATTACHMENTS);
	const rows: Awaited<ReturnType<typeof fetchScope>> = [];
	for (const scope of scopes) rows.push(...await fetchScope(scope));
	return rows
		.sort((a, b) => b.date.getTime() - a.date.getTime())
		.slice(0, MAX_ATTACHMENTS)
		.map((row) => ({
			id: row.attachment.id,
			kind: "file" as const,
			name: row.attachment.filename,
			size: row.attachment.size,
			contentType: row.attachment.contentType,
			parentId: null,
			ownerId: row.messageId,
			ownerName: senderName(row.from),
			ownerHasAvatar: false,
			role: "view" as const,
			shared: false,
			linkToken: null,
			trashedAt: row.attachment.trashedAt?.toISOString() ?? null,
			updatedAt: row.date.toISOString(),
			source: { messageId: row.messageId, subject: row.subject ?? "", direction: row.direction, canDelete: !row.mailboxId || hasMailboxPermission(permissions.get(row.mailboxId) ?? "read_only", "send_on_behalf") },
		}));
}

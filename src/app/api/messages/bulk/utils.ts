import type { BulkMessageAction, PermanentDeleteFolder } from "./types";

const allowedBulkActions = new Set<BulkMessageAction>([
	"archive",
	"trash",
	"spam",
	"read",
	"unread",
	"inbox",
	"folder",
	"delete",
]);

export function isAllowedBulkMessageAction(action: unknown): action is BulkMessageAction {
	return typeof action === "string" && allowedBulkActions.has(action as BulkMessageAction);
}

export function getStatusForBulkAction(action: BulkMessageAction): string | null {
	if (action === "archive") return "archived";
	if (action === "trash") return "trash";
	if (action === "spam") return "spam";
	if (action === "inbox") return "received";
	if (action === "folder") return "received";
	return null;
}

export function getReadValueForBulkAction(action: BulkMessageAction): boolean | null {
	if (action === "read") return true;
	if (action === "unread") return false;
	return null;
}

/**
 * Permanent deletion is only offered for mail the user already threw away, so a
 * stray "delete" can never destroy something still in the inbox, a folder or Sent.
 */
export function isPermanentlyDeletableStatus(status: string | null | undefined): status is PermanentDeleteFolder {
	return status === "trash" || status === "spam";
}

export function isPermanentDeleteFolder(folder: unknown): folder is PermanentDeleteFolder {
	return folder === "trash" || folder === "spam";
}

/** Moving into a folder only applies to mail already in that folder's mailbox, and never to drafts (they stay private to their author). */
export function canMoveToFolder(message: { mailboxId: string | null; status?: string | null }, folderMailboxId: string): boolean {
	return message.mailboxId === folderMailboxId && message.status !== "draft";
}

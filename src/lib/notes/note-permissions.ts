/**
 * Every note shows who wrote it, so only its author may change the text.
 * A note whose author account is gone can no longer be edited.
 */
export function canEditNote(authorUserId: string | null, userId: string): boolean {
	return authorUserId !== null && authorUserId === userId;
}

/** The author may delete their note, and so may anyone with full access to the mailbox. */
export function canDeleteNote(authorUserId: string | null, userId: string, canManageMailbox: boolean): boolean {
	return canManageMailbox || canEditNote(authorUserId, userId);
}

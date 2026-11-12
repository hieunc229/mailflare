/** Client-safe: used by the message page as well as the server-side invitation code. */

/** Calendar files larger than this are not read as invitations. */
export const MAX_INVITE_BYTES = 256 * 1024;

export function isInviteAttachment(attachment: { type: string; filename: string }): boolean {
	return /^text\/calendar/i.test(attachment.type) || /\.ics$/i.test(attachment.filename);
}

export function findInviteAttachment<T extends { type: string; filename: string }>(attachments: T[]): T | undefined {
	return attachments.find(isInviteAttachment);
}

import type { MailboxRef, SystemRole } from "./types";

/**
 * JMAP Mailbox ids encode Mailflare's model: a top-level Mailbox per Mailflare
 * mailbox (all its mail), system children keyed by status, and one child per
 * user folder. Ids are stable strings so clients can cache them.
 */
const SEP = "~";
export const SYSTEM_ROLES: SystemRole[] = ["inbox", "sent", "drafts", "archive", "junk", "trash"];

export function encodeMailboxRef(ref: MailboxRef): string {
	if (ref.kind === "account") return ref.mailboxId;
	if (ref.kind === "role") return `${ref.mailboxId}${SEP}${ref.role}`;
	return `${ref.mailboxId}${SEP}f${SEP}${ref.folderId}`;
}

export function decodeMailboxRef(id: unknown): MailboxRef | null {
	if (typeof id !== "string") return null;
	const parts = id.split(SEP);
	if (parts.length === 1 && parts[0]) return { kind: "account", mailboxId: parts[0] };
	if (parts.length === 2 && (SYSTEM_ROLES as string[]).includes(parts[1])) {
		return { kind: "role", mailboxId: parts[0], role: parts[1] as SystemRole };
	}
	if (parts.length === 3 && parts[1] === "f" && parts[2]) return { kind: "folder", mailboxId: parts[0], folderId: parts[2] };
	return null;
}

/** Blob ids name either a stored attachment, a message's raw MIME, or a client upload. */
export function attachmentBlobId(attachmentId: string): string {
	return `att${SEP}${attachmentId}`;
}
export function messageBlobId(messageId: string): string {
	return `msg${SEP}${messageId}`;
}
export function uploadBlobId(uploadId: string): string {
	return `up${SEP}${uploadId}`;
}
export function decodeBlobId(blobId: unknown): { kind: "att" | "msg" | "up"; id: string } | null {
	if (typeof blobId !== "string") return null;
	const index = blobId.indexOf(SEP);
	if (index < 0) return null;
	const kind = blobId.slice(0, index);
	const id = blobId.slice(index + 1);
	if (!id || (kind !== "att" && kind !== "msg" && kind !== "up")) return null;
	return { kind, id };
}

export function identityId(mailboxId: string, address: string): string {
	return `${mailboxId}${SEP}${address.toLowerCase()}`;
}
export function decodeIdentityId(id: unknown): { mailboxId: string; address: string } | null {
	if (typeof id !== "string") return null;
	const index = id.indexOf(SEP);
	if (index < 0) return null;
	return { mailboxId: id.slice(0, index), address: id.slice(index + 1) };
}

/** Status/folder predicate for each system role, as a plain description the query layer turns into SQL. */
export function roleToStatus(role: SystemRole): string {
	switch (role) {
		case "inbox":
			return "received";
		case "sent":
			return "sent";
		case "drafts":
			return "draft";
		case "archive":
			return "archived";
		case "junk":
			return "spam";
		case "trash":
			return "trash";
	}
}
export function statusToRole(status: string): SystemRole | null {
	switch (status) {
		case "received":
			return "inbox";
		case "sent":
		case "queued":
		case "failed":
			return "sent";
		case "draft":
			return "drafts";
		case "archived":
			return "archive";
		case "spam":
			return "junk";
		case "trash":
			return "trash";
		default:
			return null;
	}
}

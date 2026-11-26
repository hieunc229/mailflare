import type {
	MessageActionSkipReason,
	MessageStateField,
	MessageStateSnapshot,
	ReversibleMessageAction,
} from "./types";

const REVERSIBLE_MESSAGE_STATUSES = new Set(["received", "sent", "draft", "queued", "failed", "trash", "spam", "archived"]);

const reversibleActions = new Set<ReversibleMessageAction>([
	"archive",
	"trash",
	"spam",
	"inbox",
	"folder",
	"read",
	"unread",
	"star",
	"unstar",
	"snooze",
	"unsnooze",
]);

export function isReversibleMessageAction(value: unknown): value is ReversibleMessageAction {
	return typeof value === "string" && reversibleActions.has(value as ReversibleMessageAction);
}

/** Status and folder changes need manage access; read and star need read access, as before. */
export function actionNeedsManage(action: ReversibleMessageAction): boolean {
	return action !== "read" && action !== "unread" && action !== "star" && action !== "unstar";
}

/** Types the server reads for an action target; no bodies or internal keys. */
export type MessageActionTarget = {
	id: string;
	mailboxId: string | null;
	direction: "inbound" | "outbound" | string;
	status: string;
	read: boolean;
	starred: boolean;
	folderId: string | null;
	snoozedUntil: Date | string | null;
};

export function toIsoOrNull(value: Date | string | null | undefined): string | null {
	if (!value) return null;
	const date = value instanceof Date ? value : new Date(value);
	if (Number.isNaN(date.getTime())) return null;
	// Timestamps are stored as whole seconds in every dialect.
	return new Date(Math.floor(date.getTime() / 1000) * 1000).toISOString();
}

export function snapshotMessageState(message: MessageActionTarget): MessageStateSnapshot {
	return {
		status: message.status,
		read: message.read,
		starred: message.starred,
		folderId: message.folderId,
		snoozedUntil: toIsoOrNull(message.snoozedUntil),
	};
}

export function getChangedStateFields(previous: MessageStateSnapshot, applied: MessageStateSnapshot): MessageStateField[] {
	const fields: MessageStateField[] = [];
	if (previous.status !== applied.status) fields.push("status");
	if (previous.read !== applied.read) fields.push("read");
	if (previous.starred !== applied.starred) fields.push("starred");
	if (previous.folderId !== applied.folderId) fields.push("folderId");
	if (previous.snoozedUntil !== applied.snoozedUntil) fields.push("snoozedUntil");
	return fields;
}

export function recordHasChanges(record: { previous: MessageStateSnapshot; applied: MessageStateSnapshot }): boolean {
	return getChangedStateFields(record.previous, record.applied).length > 0;
}

export type MessageActionPatchResult =
	| { patch: Partial<MessageStateSnapshot>; reason?: never }
	| { patch?: never; reason: MessageActionSkipReason };

/** The reversible fields an action writes for one message; never ownership, bodies or attachments. */
export function getMessageActionPatch(
	action: ReversibleMessageAction,
	input: { folderId?: string | null; snoozedUntil?: string | null },
	message: MessageActionTarget,
): MessageActionPatchResult {
	switch (action) {
		case "archive":
			return { patch: { status: "archived", folderId: null } };
		case "trash":
			return { patch: { status: "trash", folderId: null } };
		case "spam":
			return message.direction === "inbound"
				? { patch: { status: "spam", folderId: null } }
				: { reason: "not_applicable" };
		case "inbox":
			return { patch: { status: "received", folderId: null, snoozedUntil: null } };
		case "folder":
			return input.folderId
				? { patch: { status: "received", folderId: input.folderId } }
				: { reason: "invalid_target" };
		case "read":
			return { patch: { read: true } };
		case "unread":
			return { patch: { read: false } };
		case "star":
			return { patch: { starred: true } };
		case "unstar":
			return { patch: { starred: false } };
		case "snooze": {
			const snoozedUntil = parseFutureDate(input.snoozedUntil);
			if (!snoozedUntil || message.direction !== "inbound") return { reason: "invalid_target" };
			return { patch: { snoozedUntil } };
		}
		case "unsnooze":
			return message.direction === "inbound"
				? { patch: { snoozedUntil: null } }
				: { reason: "not_applicable" };
	}
}

function parseFutureDate(value: string | null | undefined): string | null {
	if (typeof value !== "string") return null;
	const date = new Date(value);
	if (Number.isNaN(date.getTime()) || date <= new Date()) return null;
	return new Date(Math.floor(date.getTime() / 1000) * 1000).toISOString();
}

export function isValidReversibleStatus(status: unknown): status is string {
	return typeof status === "string" && REVERSIBLE_MESSAGE_STATUSES.has(status);
}

function isStateSnapshot(value: unknown): value is MessageStateSnapshot {
	if (!value || typeof value !== "object") return false;
	const state = value as Partial<MessageStateSnapshot>;
	return typeof state.status === "string"
		&& typeof state.read === "boolean"
		&& typeof state.starred === "boolean"
		&& (typeof state.folderId === "string" || state.folderId === null)
		&& (typeof state.snoozedUntil === "string" || state.snoozedUntil === null);
}

function fieldsMatch(
	left: MessageStateSnapshot,
	right: MessageStateSnapshot,
	fields: MessageStateField[],
): boolean {
	return fields.every((field) => left[field] === right[field]);
}

export type UndoAccess = { canRead: boolean; canManage: boolean };

export type UndoRecordPlan =
	| { id: string; patch: Partial<MessageStateSnapshot>; fields: MessageStateField[] }
	| { id: string; reason: MessageActionSkipReason };

/**
 * Restores only the fields the action changed, and only while they still hold
 * its result, so a later action is never clobbered.
 */
export function planUndoRecord(
	record: { id: string; mailboxId: string | null; previous: MessageStateSnapshot; applied: MessageStateSnapshot },
	current: MessageActionTarget,
	access: UndoAccess,
	folderMailboxId: string | null | undefined,
): UndoRecordPlan {
	if (record.id !== current.id) return { id: record.id, reason: "not_found" };
	if (!record.mailboxId || record.mailboxId !== current.mailboxId) return { id: record.id, reason: "forbidden" };
	if (!isStateSnapshot(record.previous) || !isStateSnapshot(record.applied)) {
		return { id: record.id, reason: "invalid_target" };
	}

	const fields = getChangedStateFields(record.previous, record.applied);
	if (fields.length === 0) return { id: record.id, reason: "not_applicable" };

	const needsManage = fields.some((field) => field === "status" || field === "folderId" || field === "snoozedUntil");
	if (!access.canRead || (needsManage && !access.canManage)) return { id: record.id, reason: "forbidden" };

	if (fields.includes("status") && !isValidReversibleStatus(record.previous.status)) {
		return { id: record.id, reason: "invalid_target" };
	}
	if (fields.includes("folderId") && record.previous.folderId !== null) {
		if (!folderMailboxId || folderMailboxId !== current.mailboxId) return { id: record.id, reason: "invalid_target" };
	}
	if (fields.includes("snoozedUntil") && record.previous.snoozedUntil !== null) {
		if (current.direction !== "inbound" || Number.isNaN(new Date(record.previous.snoozedUntil).getTime())) {
			return { id: record.id, reason: "invalid_target" };
		}
	}

	const currentState = snapshotMessageState(current);
	if (!fieldsMatch(currentState, record.applied, fields)) return { id: record.id, reason: "stale" };

	const patch: Partial<MessageStateSnapshot> = {};
	for (const field of fields) {
		patch[field] = record.previous[field] as never;
	}
	return { id: record.id, patch, fields };
}

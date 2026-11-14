import type { ThreadUnreadTarget } from "./field-store";
import type { MessageStateSnapshot, ReversibleMessageAction } from "./actions/types";

export const MESSAGES_CHANGED_EVENT = "mailflare:messages-changed";

export type MessageFieldPatch = {
	id: string;
	read?: boolean;
	starred?: boolean;
};

/** Authoritative state after the server applied a membership change. */
export type MessageMembershipState = MessageStateSnapshot & {
	id: string;
};

export type MessagesChangedDetail = {
	kind?: "read" | "patch" | "removed" | "restored";
	messageIds?: string[];
	read?: boolean;
	/** Per-message field patches, used when a batch has mixed values. */
	patches?: MessageFieldPatch[];
	/**
	 * Absolute grouped unread targets for rows touched by this event. Consumers
	 * apply the target instead of incrementing a count they may already have
	 * changed, so a repeated desired value and a second event are both no-ops.
	 */
	threadTargets?: ThreadUnreadTarget[];
	/**
	 * The membership mutation. Optimistic events carry the action and input so a
	 * mounted row can derive its own target; committed events carry `states`.
	 */
	action?: ReversibleMessageAction | "delete";
	folderId?: string | null;
	snoozedUntil?: string | null;
	/** Applied state per message, only after the server confirmed the change. */
	states?: MessageMembershipState[];
	/** Optimistic facts stay in this tab; other tabs wait for the committed event. */
	localOnly?: boolean;
};

export function dispatchMessagesChanged(detail?: MessagesChangedDetail): void {
	window.dispatchEvent(new CustomEvent<MessagesChangedDetail>(MESSAGES_CHANGED_EVENT, { detail }));
}

export function getMessagesChangedDetail(event: Event): MessagesChangedDetail | undefined {
	return (event as CustomEvent<MessagesChangedDetail>).detail;
}

export function isReadOnlyChange(event: Event): boolean {
	const detail = getMessagesChangedDetail(event);
	if (detail?.kind === "read") return true;
	if (detail?.kind !== "patch" || !detail.patches?.length) return false;
	return detail.patches.every((patch) => patch.read !== undefined && patch.starred === undefined);
}

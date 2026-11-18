import type { ThreadUnreadTarget } from "./field-store";

export const MESSAGES_CHANGED_EVENT = "mailflare:messages-changed";

export type MessageFieldPatch = {
	id: string;
	read?: boolean;
	starred?: boolean;
};

export type MessagesChangedDetail = {
	kind?: "read" | "patch";
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

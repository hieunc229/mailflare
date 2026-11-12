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
	/** Keep mounted views optimistic until the action request settles. */
	deferRefresh?: boolean;
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

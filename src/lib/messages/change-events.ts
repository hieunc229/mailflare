export const MESSAGES_CHANGED_EVENT = "mailflare:messages-changed";

export type MessagesChangedDetail = {
	kind?: "read";
	messageIds?: string[];
	read?: boolean;
};

export function dispatchMessagesChanged(detail?: MessagesChangedDetail): void {
	window.dispatchEvent(new CustomEvent<MessagesChangedDetail>(MESSAGES_CHANGED_EVENT, { detail }));
}

export function getMessagesChangedDetail(event: Event): MessagesChangedDetail | undefined {
	return (event as CustomEvent<MessagesChangedDetail>).detail;
}

export function isReadOnlyChange(event: Event): boolean {
	return getMessagesChangedDetail(event)?.kind === "read";
}

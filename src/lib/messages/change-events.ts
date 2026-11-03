export const MESSAGES_CHANGED_EVENT = "mailflare:messages-changed";

/**
 * Read/unread flips are the common change and already patch the client caches,
 * so listeners for lists and threads can skip their refetch when the event
 * carries this payload. Everything else stays a full refresh.
 */
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

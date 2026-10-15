/** The conversation key the thread reader already uses. */
export function threadKeyFor(message: { id: string; threadId: string | null }): string {
	return message.threadId ?? message.id;
}

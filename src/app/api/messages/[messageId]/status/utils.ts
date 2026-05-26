const allowedMessageStatuses = new Set(["received", "sent", "draft", "trash", "spam"]);

export function isAllowedMessageStatus(status: unknown): status is string {
	return typeof status === "string" && allowedMessageStatuses.has(status);
}

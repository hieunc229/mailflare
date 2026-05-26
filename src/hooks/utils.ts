import type { MessageFilterOptions, MessageFolder } from "./types";

export function parseMessageSearchQuery(query: string): MessageFilterOptions {
	let remaining = query;
	const filters: MessageFilterOptions = {};
	const titleMatch = remaining.match(/\btitle:"([^"]+)"/i) ?? remaining.match(/\btitle:([^\s]+)/i);

	if (titleMatch?.[1]) {
		filters.title = titleMatch[1].trim();
		remaining = remaining.replace(titleMatch[0], " ");
	}

	if (/(^|\s):unread(\s|$)/i.test(remaining)) {
		filters.read = "unread";
		remaining = remaining.replace(/(^|\s):unread(?=\s|$)/gi, " ");
	} else if (/(^|\s):read(\s|$)/i.test(remaining)) {
		filters.read = "read";
		remaining = remaining.replace(/(^|\s):read(?=\s|$)/gi, " ");
	}

	const textQuery = remaining.replace(/\s+/g, " ").trim();
	if (textQuery) filters.query = textQuery;

	return filters;
}

export function getMessageQueryParams(
	folder: MessageFolder,
	mailboxId?: string | null,
	filters?: MessageFilterOptions,
) {
	const params = new URLSearchParams();

	if (folder === "inbox") {
		params.set("direction", "inbound");
		params.set("status", "received");
	}

	if (folder === "sent") {
		params.set("direction", "outbound");
		params.set("status", "sent");
	}

	if (folder === "drafts") {
		params.set("direction", "outbound");
		params.set("status", "draft");
	}

	if (folder === "trash" || folder === "spam") {
		params.set("status", folder);
	}

	if (mailboxId) params.set("mailboxId", mailboxId);
	const parsedFilters = filters?.query ? { ...filters, ...parseMessageSearchQuery(filters.query) } : filters;
	if (parsedFilters?.query?.trim()) params.set("q", parsedFilters.query.trim());
	if (parsedFilters?.title?.trim()) params.set("title", parsedFilters.title.trim());
	if (parsedFilters?.read && parsedFilters.read !== "all") params.set("read", parsedFilters.read);

	return params;
}

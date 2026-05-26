export type DraftRouteParams = {
	params: Promise<{ id: string }>;
};

export type DraftPayload = {
	mailboxId?: string | null;
	from?: string;
	to?: string;
	subject?: string;
	text?: string;
	html?: string;
};

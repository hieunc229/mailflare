export type MailboxRouteParams = {
	params: Promise<{ id: string }>;
};

export type MailboxUpdateValues = {
	displayName?: string | null;
	signature?: string | null;
	autoReplyEnabled?: boolean;
	autoReplySubject?: string;
	autoReplyBody?: string;
	autoReplyStartAt?: Date | null;
	autoReplyEndAt?: Date | null;
	autoReplyActivatedAt?: Date | null;
	useAllDomains?: boolean;
};

/** The PATCH body as parsed by updateMailboxSchema; dates arrive as ISO strings. */
export type MailboxUpdateInput = Omit<MailboxUpdateValues, "autoReplyStartAt" | "autoReplyEndAt" | "autoReplyActivatedAt"> & {
	autoReplyStartAt?: string | Date | null;
	autoReplyEndAt?: string | Date | null;
};

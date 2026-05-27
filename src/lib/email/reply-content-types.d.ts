export type QuotedEmailContent = {
	dateLine: string;
	content: string;
};

export type ReplyContentParts = {
	latestContent: string;
	quotedContent: QuotedEmailContent[];
};

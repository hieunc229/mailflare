import type { Message } from "@/hooks/types";
import type { ReplyContentParts } from "@/lib/email/reply-content-types";

export type MessageDetailResponse = {
	message?: Message;
	body?: {
		htmlBody: string | null;
		textBody: string | null;
	} | null;
	error?: string;
};

export type MessageBodyDisplay = ReplyContentParts & {
	htmlBody: string | null;
	hasQuotedContent: boolean;
};

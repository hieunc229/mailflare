import type { Message } from "@/hooks/types";
import type { ReplyContentParts } from "@/lib/email/reply-content-types";

export type MessageDetailResponse = {
	message?: Message;
	body?: {
		htmlBody: string | null;
		textBody: string | null;
	} | null;
	attachments?: MessageAttachment[];
	unsubscribeUrl?: string | null;
	/** Unsubscribe link found in the body when the message has no List-Unsubscribe header. */
	unsubscribeViaBody?: string | null;
	/** ISO time a queued message is waiting to be sent, when it is a scheduled send. */
	scheduledAt?: string | null;
	error?: string;
};

export type MessageAttachment = {
	contentId: string | null;
	disposition: "attachment" | "inline";
	filename: string;
	id: string;
	messageId: string;
	size: number;
	type: string;
};

export type MessageBodyDisplay = ReplyContentParts & {
	htmlBody: string | null;
	/** Quoted/forwarded HTML a Mailflare composer folded under the message, shown collapsed. */
	quotedHtml: string | null;
	hasQuotedContent: boolean;
};

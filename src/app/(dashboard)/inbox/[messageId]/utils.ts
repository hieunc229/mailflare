import { authFetch } from "@/lib/auth/client";
import { getEmailAddress } from "@/lib/email/address";
import { getDisplayNameForAddress } from "@/lib/contacts/utils";
import { htmlToReadableText, splitRepliedEmailContent } from "@/lib/email/reply-content-utils";
import type { Message } from "@/hooks/types";
import type { MessageBodyDisplay, MessageDetailResponse } from "./types";

export async function fetchMessageDetail(messageId: string): Promise<MessageDetailResponse> {
	const response = await authFetch(`/api/messages/${messageId}`);
	return (await response.json()) as MessageDetailResponse;
}

export function getMessageHeaderParties(message: Message) {
	return {
		fromName: getDisplayNameForAddress(message.fromAddr, message.fromContactName),
		fromAddress: getEmailAddress(message.fromAddr),
		toName: getDisplayNameForAddress(message.toAddr, message.toContactName),
	};
}

export function getMessageBodyDisplay(
	textBody: string | null | undefined,
	htmlBody: string | null | undefined,
	fallback: string | null | undefined,
): MessageBodyDisplay {
	const textSource = textBody ?? (htmlToReadableText(htmlBody) || fallback || "");
	const parts = splitRepliedEmailContent(textSource);

	return {
		...parts,
		htmlBody: parts.quotedContent.length > 0 ? null : htmlBody ?? null,
		hasQuotedContent: parts.quotedContent.length > 0,
	};
}

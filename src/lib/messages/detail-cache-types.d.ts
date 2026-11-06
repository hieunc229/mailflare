import type { Message } from "@/hooks/types";

export type CachedMessageDetail = {
	message?: Message;
	body?: { htmlBody: string | null; textBody: string | null } | null;
	attachments?: Array<{
		contentId: string | null;
		disposition: "attachment" | "inline";
		filename: string;
		id: string;
		messageId: string;
		size: number;
		type: string;
	}>;
	unsubscribeUrl?: string | null;
	unsubscribeViaBody?: string | null;
	scheduledAt?: string | null;
	error?: string;
};

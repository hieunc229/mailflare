import type { ContactNameSource } from "@/lib/contacts/types";
import { getPartyDisplayName } from "@/lib/contacts/utils";
import type { NewMessageNotification } from "@/lib/realtime/types";

type NewMessageNotificationInput = {
	messageId: string;
	mailboxId: string;
	fromAddr: string;
	contact: ContactNameSource | null;
	subject: string | null;
};

/**
 * The realtime and push payload for a stored inbound message. The contact row
 * may carry the first name ever learned for a shared address, so the label is
 * resolved from this message's own From header first.
 */
export function buildNewMessageNotification(input: NewMessageNotificationInput): NewMessageNotification {
	return {
		type: "new_message",
		messageId: input.messageId,
		mailboxId: input.mailboxId,
		from: input.fromAddr,
		fromName: getPartyDisplayName(input.fromAddr, input.contact),
		subject: input.subject,
	};
}

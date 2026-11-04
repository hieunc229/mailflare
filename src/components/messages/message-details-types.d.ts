import type { Message } from "@/hooks/types";

export type MessageDetailsMessage = Pick<
	Message,
	| "id"
	| "direction"
	| "fromAddr"
	| "fromContactName"
	| "toAddr"
	| "ccAddr"
	| "bccAddr"
	| "replyTo"
	| "subject"
	| "createdAt"
>;

export type MessageDetailsPanelProps = {
	message: MessageDetailsMessage;
	onClose?: () => void;
	className?: string;
};

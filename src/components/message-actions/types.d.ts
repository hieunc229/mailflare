import type { MessageDirection } from "@/hooks/types";

export type MessageActionStatus = "trash" | "spam";

export type MessageActionsProps = {
	messageId: string;
	direction: MessageDirection;
	status: string;
};

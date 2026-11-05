import type { ThreadMessage } from "@/hooks/types";

export type ThreadMessageActionsProps = {
	message: ThreadMessage;
	mailboxId: string | null;
	ownAddress?: string | null;
	ownAddresses?: string[];
	starOnly?: boolean;
	detailsOpen?: boolean;
	onToggleDetails?: () => void;
	/** Adds a note about this email; the menu entry shows only when given. */
	onAddNote?: (messageId: string) => void;
};

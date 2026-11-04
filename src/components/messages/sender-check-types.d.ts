import type { MessageDetailsMessage } from "./message-details-types";

export type SenderCheckProps = {
	message: MessageDetailsMessage;
};

export type SenderCheckBadgeProps = SenderCheckProps & {
	className?: string;
};

export type SenderCheckNoticeProps = SenderCheckProps & {
	/** Whether the details panel is open; drives the chevron and the expanded state. */
	detailsOpen?: boolean;
	/** Opens or closes the sender details panel. */
	onViewDetails: () => void;
	/** Announce the warning when it appears after authentication loads. */
	announce?: boolean;
	className?: string;
};

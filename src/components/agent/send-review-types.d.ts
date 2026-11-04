export type ReviewSnapshot = {
	from: string;
	to: string;
	cc: string | null;
	bcc: string | null;
	subject: string;
	text: string | null;
	html: string | null;
	scheduledAt: string | null;
	attachments: { id: string; filename: string; size: number }[];
};

export type SendReviewProps = {
	approvalId: string;
	snapshot: ReviewSnapshot;
	/** Recipients that are not saved contacts or people the user has written to before. */
	unfamiliarRecipients?: string[];
	onClose?: () => void;
	onSent?: (messageId: string) => void;
};

export type AgentReviewResponse = { status: string; snapshot: ReviewSnapshot | null; stale: boolean; unfamiliarRecipients?: string[]; error?: string };

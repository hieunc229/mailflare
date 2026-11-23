export interface GeneralSettings {
	outboundAttachmentMaxMb: number;
	outboundAttachmentCeilingMb: number;
	/** Per-user Drive cap in GB; null when unlimited. */
	driveStorageLimitGb: number | null;
	/** The sentence above the Shared Files cards is sent with the message. */
	sharedFilesNoticeEnabled: boolean;
	/** The administrator's own sentence; null uses the translated default. */
	sharedFilesNoticeText: string | null;
	/** How long the download links stay valid, in days. */
	sharedFilesLinkDays: number;
	/** Fixed language for the notice; null follows the sender's language. */
	sharedFilesNoticeLocale: string | null;
	/** Attachment-like cards, or a plain list of links. */
	sharedFilesCardStyle: "card" | "links";
}

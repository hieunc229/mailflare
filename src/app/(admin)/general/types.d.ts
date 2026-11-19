export interface GeneralSettings {
	outboundAttachmentMaxMb: number;
	outboundAttachmentCeilingMb: number;
	/** Text above Shared Files links; null is the translated default, empty adds no message. */
	sharedFilesNotice: string | null;
	/** Per-user Drive cap in GB; null when unlimited. */
	driveStorageLimitGb: number | null;
}

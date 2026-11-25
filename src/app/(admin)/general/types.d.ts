export interface GeneralSettings {
	outboundAttachmentMaxMb: number;
	outboundAttachmentCeilingMb: number;
	/** Per-user Drive cap in GB; null when unlimited. */
	driveStorageLimitGb: number | null;
	/** CalDAV/CardDAV sync; off until an administrator turns it on. */
	davEnabled: boolean;
}

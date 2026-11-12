export interface SaveToDriveRouteParams {
	params: Promise<{
		attachmentId: string;
		messageId: string;
	}>;
}

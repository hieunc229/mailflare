export function getAttachmentContentDisposition(filename: string, inline: boolean): string {
	const safeFilename = filename.replace(/["\\\r\n]/g, "_");
	return `${inline ? "inline" : "attachment"}; filename="${safeFilename}"`;
}

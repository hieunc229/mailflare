import { File as FileIcon, FileArchive, FileAudio, FileCode, FileImage, FileSpreadsheet, FileText, FileVideo, Folder, Presentation } from "@/components/icons";
import type { DriveItemDto } from "@/lib/drive/types";

const extensionOf = (name: string) => name.slice(name.lastIndexOf(".") + 1).toLowerCase();
const SPREADSHEET = /spreadsheet|ms-excel|csv/;
const PRESENTATION = /presentation|ms-powerpoint/;
const ARCHIVE = /zip|compressed|x-tar|gzip|rar|7z/;
const CODE_EXTENSIONS = new Set(["js", "ts", "tsx", "jsx", "json", "html", "css", "py", "rb", "go", "rs", "java", "c", "cpp", "h", "sh", "sql", "yml", "yaml", "xml"]);

// One colour per kind of file. Palette classes, not hex, so the dark theme remaps them.
export function driveIconFor(item: Pick<DriveItemDto, "kind" | "contentType" | "name">) {
	if (item.kind === "folder") return { Icon: Folder, className: "text-amber-500" };
	const type = item.contentType;
	const extension = extensionOf(item.name);
	if (type.startsWith("image/")) return { Icon: FileImage, className: "text-rose-500" };
	if (type.startsWith("video/")) return { Icon: FileVideo, className: "text-purple-500" };
	if (type.startsWith("audio/")) return { Icon: FileAudio, className: "text-orange-500" };
	if (type === "application/pdf" || extension === "pdf") return { Icon: FileText, className: "text-red-600" };
	if (SPREADSHEET.test(type) || ["xls", "xlsx", "ods", "csv", "numbers"].includes(extension)) return { Icon: FileSpreadsheet, className: "text-green-600" };
	if (PRESENTATION.test(type) || ["ppt", "pptx", "odp", "key"].includes(extension)) return { Icon: Presentation, className: "text-orange-600" };
	if (ARCHIVE.test(type) || ["zip", "rar", "7z", "tar", "gz"].includes(extension)) return { Icon: FileArchive, className: "text-yellow-700" };
	if (CODE_EXTENSIONS.has(extension) || type === "application/json" || type.includes("javascript") || type.includes("xml")) return { Icon: FileCode, className: "text-teal-500" };
	if (type.startsWith("text/") || type.includes("word") || type.includes("opendocument.text") || ["doc", "docx", "odt", "rtf", "txt", "md", "pages"].includes(extension)) return { Icon: FileText, className: "text-blue-500" };
	return { Icon: FileIcon, className: "text-neutral-500" };
}

export type DriveSortKey = "name" | "owner" | "updatedAt" | "size";

export function sortDriveItems<T extends Pick<DriveItemDto, "kind" | "name" | "updatedAt"> & { ownerName?: string; role?: string; size?: number }>(items: T[], key: DriveSortKey, ascending: boolean): T[] {
	const direction = ascending ? 1 : -1;
	const text = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
	return [...items].sort((a, b) => {
		if (a.kind !== b.kind) return a.kind === "folder" ? -1 : 1;
		let compared: number;
		if (key === "updatedAt") compared = a.updatedAt.localeCompare(b.updatedAt);
		else if (key === "size") compared = (a.size ?? 0) - (b.size ?? 0);
		else if (key === "owner") compared = text(a.role === "owner" ? "" : a.ownerName ?? "", b.role === "owner" ? "" : b.ownerName ?? "");
		else compared = 0;
		return (compared || text(a.name, b.name)) * direction;
	});
}

/** URL of a file's bytes: a Drive file, or an email attachment when the item comes from mail. */
export function driveFileUrl(item: Pick<DriveItemDto, "id" | "source">, download = false): string {
	return item.source ? `/api/drive/attachments/${encodeURIComponent(item.id)}/content${download ? "?download=1" : ""}` : contentUrl(item.id, download);
}

export function emailUrl(source: NonNullable<DriveItemDto["source"]>): string {
	return `/${source.direction === "outbound" ? "sent" : "inbox"}/${encodeURIComponent(source.messageId)}`;
}

export function contentUrl(id: string, download = false): string {
	return `/api/drive/items/${encodeURIComponent(id)}/content${download ? "?download=1" : ""}`;
}

export function publicContentUrl(token: string, itemId: string, download = false): string {
	return `/api/drive/public/${encodeURIComponent(token)}?item=${encodeURIComponent(itemId)}&${download ? "download=1" : "content=1"}`;
}

export function canPreview(contentType: string): boolean {
	return contentType.startsWith("image/") && contentType !== "image/svg+xml" || contentType.startsWith("video/") || contentType.startsWith("audio/") || contentType === "application/pdf" || contentType === "text/plain" || contentType === "text/csv" || contentType === "application/json";
}

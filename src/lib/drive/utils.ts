import type { DriveCrumb, DriveRole, DriveRow } from "./types";

/**
 * Files upload in parts into a multipart upload (R2, or Backblaze B2 when configured), so no whole file is ever buffered in the Worker;
 * with B2 one part at a time is held in memory to be signed, so keep this well under the 128 MB Worker limit. A part must stay
 * under the 100 MB request limit of Cloudflare's Free and Pro plans, and R2 allows 10,000 parts per object, which caps a
 * file at about 640 GB. Lowering the part size shrinks that cap; raising it needs a plan with larger request bodies.
 */
export const DRIVE_PART_BYTES = 64 * 1024 * 1024;
/** How long an interrupted upload can be resumed. The bucket should be set to abort incomplete multipart uploads after about as long. */
export const DRIVE_UPLOAD_RESUME_MS = 3 * 24 * 60 * 60 * 1000;
export const DRIVE_MAX_PARTS = 10_000;
export const DRIVE_MAX_FILE_BYTES = DRIVE_PART_BYTES * DRIVE_MAX_PARTS;
export const DRIVE_MAX_NAME_LENGTH = 255;
export const DRIVE_MAX_DEPTH = 64;

export function normalizeDriveName(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const name = value.replace(/[\u0000-\u001f/\\]/g, " ").replace(/\s+/g, " ").trim().slice(0, DRIVE_MAX_NAME_LENGTH);
	return name && name !== "." && name !== ".." ? name : null;
}

export function canEditDrive(role: DriveRole | null): boolean {
	return role === "owner" || role === "edit";
}

export function driveObjectKey(ownerId: string, itemId: string): string {
	return `drive/${ownerId}/${itemId}`;
}

export function toDriveCrumbs(chain: DriveRow[]): DriveCrumb[] {
	return chain.map((item) => ({ id: item.id, name: item.name }));
}

export function formatDriveSize(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	const units = ["KB", "MB", "GB", "TB"];
	let value = bytes / 1024;
	let unit = 0;
	while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1; }
	return `${value >= 10 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

export function driveContentDisposition(filename: string, inline: boolean): string {
	const ascii = filename.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
	return `${inline ? "inline" : "attachment"}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

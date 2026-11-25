import type { DriveRoot } from "@/lib/import/takeout-data-types";
import type { DriveRunSummary } from "@/lib/import/takeout-drive-types";

/** The folder to import from without asking: the one called Drive, or the only one there is; otherwise the user picks (""). */
export function defaultDriveRoot(roots: DriveRoot[]): string {
	const drive = roots.find((root) => root.label.toLowerCase() === "drive");
	return drive?.key ?? (roots.length === 1 ? roots[0].key : "");
}

/** `Google Drive (2026-11-21)`, from the local date. */
export function newFolderName(now: Date): string {
	const pad = (value: number) => String(value).padStart(2, "0");
	return `Google Drive (${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())})`;
}

/** The user's folders with their path as a label ("Docs / Taxes"), sorted by it. A cycle or a missing parent ends the path. */
export function folderOptions(folders: { id: string; name: string; parentId: string | null }[]): { id: string; label: string }[] {
	const byId = new Map(folders.map((folder) => [folder.id, folder]));
	const labelOf = (id: string) => {
		const names: string[] = [];
		const seen = new Set<string>();
		for (let current = byId.get(id); current && !seen.has(current.id) && names.length < 64; current = current.parentId ? byId.get(current.parentId) : undefined) {
			seen.add(current.id);
			names.unshift(current.name);
		}
		return names.join(" / ");
	};
	return folders.map((folder) => ({ id: folder.id, label: labelOf(folder.id) })).sort((a, b) => a.label.localeCompare(b.label));
}

/** Free Drive storage in bytes, or null when there is no limit (or it is not known). */
export function freeStorage(used: number | undefined, limit: number | null | undefined): number | null {
	return typeof used === "number" && typeof limit === "number" ? Math.max(0, limit - used) : null;
}

/** "failed" when nothing got in (or the storage was full before anything did), "partial" when something went wrong along the way, else "success". */
export function driveTone(summary: DriveRunSummary): "success" | "partial" | "failed" {
	const problem = summary.failed > 0 || summary.aborted || summary.storageFull || summary.stoppedAfterFailures;
	if (!problem) return "success";
	return summary.imported + summary.skipped === 0 ? "failed" : "partial";
}

/**
 * Above this many files a very large import can reach the daily limits of Cloudflare's free plan (every file takes a few
 * requests and database rows), so the card warns and offers to import one folder at a time.
 */
export const LARGE_IMPORT_FILES = 5000;

export const isLargeImport = (files: number): boolean => files > LARGE_IMPORT_FILES;

/** The folders at the top of the chosen Takeout folder, with how many files each holds (files below it), by name. Loose files at the top are in none. */
export function topFolders(files: { segments: string[] }[]): { name: string; files: number }[] {
	const counts = new Map<string, number>();
	for (const file of files) if (file.segments.length > 1) counts.set(file.segments[0], (counts.get(file.segments[0]) ?? 0) + 1);
	return [...counts].map(([name, count]) => ({ name, files: count })).sort((a, b) => a.name.localeCompare(b.name));
}

/** Import needs a chosen Takeout folder that was not cut short (another folder of the export being cut short does not matter), with files, and no run going. */
export function canStartDrive(files: number, running: boolean, root: Pick<DriveRoot, "tooMany"> | undefined): boolean {
	return files > 0 && !running && !!root && !root.tooMany;
}

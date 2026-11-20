import { contentTypeForName, folderPrefixes, MAX_IMPORT_FOLDERS, NESTED_TOO_DEEPLY } from "../drive/import-utils";
import type { DriveUploadSource } from "@/app/(drive)/drive-upload";
import type { DriveFile } from "./takeout-data-types";
import type { DrivePostResult, DriveRunDeps, DriveRunSettings, DriveRunSummary } from "./takeout-drive-types";
import { createZipPartReader, openZipEntry } from "./zip-utils";

/** What one files request takes; the route refuses more (it bounds the D1 queries one request makes). */
const FILES_PER_REQUEST = 140;
const FOLDERS_PER_FILES_REQUEST = 25;
const PATHS_PER_FOLDERS_REQUEST = 100;
const POST_TRIES = 5;
const RETRY_MS = 2000;
const MAX_ERRORS_SHOWN = 5;
/** Uploads failing one after another point at something wrong (network, permissions, limits); going on would only spend requests. */
export const MAX_CONSECUTIVE_FAILURES = 5;
/** Enough to tell a PNG or PDF from markup. */
const HEAD_BYTES = 16;

/** A zip entry as an upload source: read forward part by part, checked against its CRC-32 before the upload is completed. */
async function sourceFor(file: DriveFile, name: string): Promise<DriveUploadSource & { close(): Promise<void> }> {
	const stream = await openZipEntry(file.file, file.entry);
	const reader = stream.getReader();
	let head = new Uint8Array(0);
	try {
		if (file.size > 0) head = ((await reader.read()).value ?? head).slice(0, HEAD_BYTES);
	} finally {
		await reader.cancel().catch(() => {});
	}
	const parts = createZipPartReader(file.file, file.entry);
	return {
		name,
		size: file.size,
		type: contentTypeForName(name, head),
		fingerprint: `gt:${file.crc32.toString(16).padStart(8, "0")}:${file.size}`,
		readPart: parts.readPart,
		verify: async () => {
			try { await parts.verify(); } finally { await parts.close(); }
		},
		close: parts.close,
	};
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * Imports Takeout Drive files into Drive: creates the folders (all of them are found or created by the server, so a
 * repeat reuses them), asks the server what to do with each batch of files (skip, or upload under a name), then uploads
 * one file at a time through the ordinary multipart upload, checking each against its CRC-32. A file that fails is
 * counted and the run goes on; a full Drive, Stop, or five uploads failing in a row end it. Repeating the run skips what is already there and
 * continues a half-sent file from its last stored part.
 */
export async function importDriveFiles(files: DriveFile[], dirs: { segments: string[] }[], settings: DriveRunSettings, run: DriveRunDeps): Promise<DriveRunSummary> {
	const summary: DriveRunSummary = { total: files.length, imported: 0, skipped: 0, failed: 0, tooDeep: 0, bytes: 0, errors: [], aborted: false, storageFull: false, stoppedAfterFailures: false };
	let failuresInARow = 0;
	const sleep = run.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
	const stopped = () => !!run.signal?.aborted;
	const report = (current: string, percent: number) => run.onProgress?.({ done: summary.imported + summary.skipped + summary.failed, total: summary.total, current, percent });
	const fail = (path: string, reason: string) => {
		summary.failed += 1;
		if (summary.errors.length < MAX_ERRORS_SHOWN) summary.errors.push(`${path}: ${reason}`);
	};

	async function post(path: "/api/drive/import/folders" | "/api/drive/import/files", body: unknown): Promise<DrivePostResult> {
		for (let attempt = 1; ; attempt += 1) {
			const result = await run.post(path, body, run.signal);
			if (result.status === 200) return result;
			const retryable = result.status >= 500 || result.status === 429;
			if (!retryable) throw new Error(typeof result.data.error === "string" ? result.data.error : `Request failed (${result.status})`);
			if (attempt >= POST_TRIES) throw new Error(`The server did not answer (${result.status})`);
			await sleep(result.retryAfterMs ?? RETRY_MS * 2 ** (attempt - 1));
		}
	}

	async function makeFolders(parentId: string | null, paths: string[][]): Promise<{ folders: Record<string, string>; errors: Record<string, string> }> {
		const folders: Record<string, string> = {};
		const errors: Record<string, string> = {};
		for (let start = 0; start < paths.length;) {
			// At most MAX_IMPORT_FOLDERS distinct folders (every ancestor counted) and PATHS_PER_FOLDERS_REQUEST paths a request; a path always goes alone if it must.
			let end = start + 1;
			while (end < paths.length && end - start < PATHS_PER_FOLDERS_REQUEST && folderPrefixes(paths.slice(start, end + 1)).size <= MAX_IMPORT_FOLDERS) end += 1;
			const { data } = await post("/api/drive/import/folders", { parentId, paths: paths.slice(start, end) });
			start = end;
			Object.assign(folders, data.folders);
			Object.assign(errors, data.errors);
		}
		return { folders, errors };
	}

	let target = settings.parentId;
	if (settings.newFolderName) {
		const made = await makeFolders(null, [[settings.newFolderName]]);
		const id = made.folders[settings.newFolderName];
		if (!id) throw new Error(made.errors[settings.newFolderName] ?? "Could not create the folder");
		target = id;
	}

	const dirKey = (file: DriveFile) => file.segments.slice(0, -1).join("/");
	const sorted = [...files].sort((a, b) => dirKey(a).localeCompare(dirKey(b)) || a.name.localeCompare(b.name));
	/** Folder path to id, for paths already created. */
	const folderIds = new Map<string, string>();
	const folderErrors = new Map<string, string>();
	const ensure = async (paths: string[][]) => {
		const wanted = paths.filter((path) => path.length > 0 && !folderIds.has(path.join("/")) && !folderErrors.has(path.join("/")));
		if (wanted.length === 0) return;
		const made = await makeFolders(target, wanted);
		for (const [key, id] of Object.entries(made.folders)) folderIds.set(key, id);
		for (const [key, reason] of Object.entries(made.errors)) folderErrors.set(key, reason);
	};

	// Empty folders first, so they exist even when nothing is uploaded into them.
	const emptyDirs = [...new Map(dirs.map((dir) => [dir.segments.join("/"), dir.segments])).values()];
	for (let start = 0; start < emptyDirs.length && !stopped(); start += PATHS_PER_FOLDERS_REQUEST) await ensure(emptyDirs.slice(start, start + PATHS_PER_FOLDERS_REQUEST));

	let index = 0;
	while (index < sorted.length) {
		if (stopped()) { summary.aborted = true; return summary; }
		const batch: DriveFile[] = [];
		const batchFolders = new Set<string>();
		while (index < sorted.length && batch.length < FILES_PER_REQUEST) {
			const key = dirKey(sorted[index]);
			if (key && !batchFolders.has(key) && batchFolders.size >= FOLDERS_PER_FILES_REQUEST) break;
			if (key) batchFolders.add(key);
			batch.push(sorted[index]);
			index += 1;
		}
		await ensure([...batchFolders].map((key) => key.split("/")));
		const usable = batch.filter((file) => !folderErrors.has(dirKey(file)));
		for (const file of batch) {
			const reason = folderErrors.get(dirKey(file));
			if (reason === NESTED_TOO_DEEPLY) { summary.skipped += 1; summary.tooDeep += 1; }
			else if (reason) fail(file.segments.join("/"), reason);
		}
		report("", 0);
		const results = usable.length === 0 ? [] : (await post("/api/drive/import/files", {
			files: usable.map((file) => ({ folderId: dirKey(file) ? folderIds.get(dirKey(file))! : target, name: file.name, size: file.size, fingerprint: `gt:${file.crc32.toString(16).padStart(8, "0")}:${file.size}` })),
		})).data.results as ({ action: "skip" } | { action: "upload"; name: string } | { action: "error"; error: string })[];
		for (const [position, file] of usable.entries()) {
			if (stopped()) { summary.aborted = true; return summary; }
			const path = file.segments.join("/");
			const result = results[position];
			if (!result || result.action === "error") { fail(path, result?.error ?? "No answer from the server"); report("", 0); continue; }
			if (result.action === "skip") { summary.skipped += 1; failuresInARow = 0; report("", 0); continue; }
			let source: Awaited<ReturnType<typeof sourceFor>> | null = null;
			try {
				report(path, 0);
				source = await sourceFor(file, result.name);
				await run.upload(source, dirKey(file) ? folderIds.get(dirKey(file))! : target, (percent) => report(path, percent), run.signal);
				summary.imported += 1;
				summary.bytes += file.size;
				failuresInARow = 0;
			} catch (error) {
				if (stopped()) { summary.aborted = true; return summary; }
				fail(path, messageOf(error));
				if ((error as { status?: number }).status === 413) { summary.storageFull = true; return summary; }
				failuresInARow += 1;
				if (failuresInARow >= MAX_CONSECUTIVE_FAILURES) { summary.stoppedAfterFailures = true; return summary; }
			} finally {
				await source?.close().catch(() => {});
			}
			report("", 0);
		}
	}
	return summary;
}

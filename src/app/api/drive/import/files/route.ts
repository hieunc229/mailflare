import { NextResponse } from "next/server";
import { authorizeDrive } from "@/lib/drive/auth";
import { findEditableFolders, planImportFiles } from "@/lib/drive/import-store";
import type { ImportFileOutcome } from "@/lib/drive/import-store-types";
import { RequestBodyTooLargeError } from "@/lib/http/errors";
import { readJsonBody } from "@/lib/http/request";

const MAX_BODY_BYTES = 512 * 1024;
/**
 * D1 allows 50 queries per invocation. A request costs the session (a few), the folders and one query per level of
 * their ancestors (at most 24, shared by all folders), up to 7 share lookups, and 2 + 2 for planning names: names are
 * looked up 74 at a time, so 140 files need at most 2 + 2. Together at most 40.
 */
const MAX_FILES = 140;
const MAX_FOLDERS = 25;

type FileRequest = { folderId: string | null; name: string; size: number; fingerprint: string };

const isFileRequest = (value: unknown): value is FileRequest => {
	const entry = value as Partial<FileRequest> | null;
	return !!entry && typeof entry === "object"
		&& (entry.folderId === null || typeof entry.folderId === "string")
		&& typeof entry.name === "string" && typeof entry.size === "number" && typeof entry.fingerprint === "string";
};

/**
 * Plans what to do with each Takeout Drive file of one folder batch: skip (already imported), upload under a name
 * (which may resume an interrupted upload), or an error. Metadata only; the bytes go through the ordinary upload routes.
 */
export async function POST(request: Request) {
	const auth = await authorizeDrive(request, true);
	if (auth.error) return auth.error;
	const { db, user } = auth;
	let body: { files?: unknown };
	try {
		body = await readJsonBody(request, MAX_BODY_BYTES);
	} catch (error) {
		return error instanceof RequestBodyTooLargeError
			? NextResponse.json({ error: "Request body is too large" }, { status: 413 })
			: NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
	}
	const { files } = body;
	if (!Array.isArray(files) || files.length < 1 || files.length > MAX_FILES || !files.every(isFileRequest)) return NextResponse.json({ error: "Invalid files" }, { status: 400 });
	const folderIds = [...new Set(files.map((file) => file.folderId).filter((id): id is string => id !== null))];
	if (folderIds.length > MAX_FOLDERS) return NextResponse.json({ error: "Too many folders in one request" }, { status: 400 });

	// The owner of each folder the caller may edit; anything else is "not found", whether or not it exists.
	const owners = await findEditableFolders(db, user.id, folderIds);
	const ownerOf = (folderId: string | null) => (folderId === null ? user.id : owners.get(folderId)?.ownerId);
	const allowed = files.map((file, index) => ({ file, index })).filter(({ file }) => ownerOf(file.folderId));
	const planned = await planImportFiles(db, allowed.map(({ file }) => ({ ownerId: ownerOf(file.folderId)!, ...file })));
	const results: ImportFileOutcome[] = files.map(() => ({ action: "error", error: "Folder not found" }));
	allowed.forEach(({ index }, position) => { results[index] = planned[position]; });
	return NextResponse.json({ results });
}

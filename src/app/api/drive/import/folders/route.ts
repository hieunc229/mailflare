import { NextResponse } from "next/server";
import { authorizeDrive } from "@/lib/drive/auth";
import { ensureImportFolders, findEditableFolders } from "@/lib/drive/import-store";
import { folderPrefixes, MAX_IMPORT_FOLDERS } from "@/lib/drive/import-utils";
import { DRIVE_MAX_DEPTH } from "@/lib/drive/utils";
import { RequestBodyTooLargeError } from "@/lib/http/errors";
import { readJsonBody } from "@/lib/http/request";

const MAX_BODY_BYTES = 1024 * 1024;
const MAX_PATHS = 100;

/**
 * Finds or creates the folders a Takeout Drive import needs, below a folder (or the root of My Drive). Metadata only:
 * the file bytes go through the ordinary upload routes. Repeating a call changes nothing. D1 allows 50 queries per
 * invocation: the parent costs at most 25 (see findEditableFolders), the existing folders 1 (at most 64 distinct names)
 * and the inserts at most 11 (64 rows, 6 a statement), with the session a few: at most 40.
 */
export async function POST(request: Request) {
	const auth = await authorizeDrive(request, true);
	if (auth.error) return auth.error;
	const { db, user } = auth;
	let body: { parentId?: unknown; paths?: unknown };
	try {
		body = await readJsonBody(request, MAX_BODY_BYTES);
	} catch (error) {
		return error instanceof RequestBodyTooLargeError
			? NextResponse.json({ error: "Request body is too large" }, { status: 413 })
			: NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
	}
	const { paths } = body;
	const shapeOk = Array.isArray(paths) && paths.length >= 1 && paths.length <= MAX_PATHS
		&& paths.every((path) => Array.isArray(path) && path.length >= 1 && path.length <= DRIVE_MAX_DEPTH && path.every((segment) => typeof segment === "string"));
	if (!shapeOk) return NextResponse.json({ error: "Invalid folder paths" }, { status: 400 });
	if (folderPrefixes(paths as string[][]).size > MAX_IMPORT_FOLDERS) return NextResponse.json({ error: "Too many folders in one request" }, { status: 400 });
	if (body.parentId !== null && body.parentId !== undefined && typeof body.parentId !== "string") return NextResponse.json({ error: "Invalid parent folder" }, { status: 400 });

	let ownerId = user.id;
	let parentId: string | null = null;
	let parentDepth = 0;
	if (body.parentId) {
		const parent = (await findEditableFolders(db, user.id, [body.parentId])).get(body.parentId);
		if (!parent) return NextResponse.json({ error: "Folder not found" }, { status: 404 });
		parentId = body.parentId;
		ownerId = parent.ownerId;
		parentDepth = parent.depth;
	}
	return NextResponse.json(await ensureImportFolders(db, ownerId, parentId, parentDepth, paths as string[][]));
}

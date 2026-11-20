import { and, asc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import type { getDb } from "@/db";
import { driveItems, driveShares } from "@/db/schema";
import { chunk, SELECT_CHUNK, STATEMENTS_PER_BATCH } from "@/lib/calendar/import-store-utils";
import { newId } from "@/lib/ids";
import { collisionCandidates, collisionPattern, importName, NESTED_TOO_DEEPLY, planImportFile } from "./import-utils";
import type { ImportFileInput, ImportFileOutcome, ImportFolderResult } from "./import-store-types";
import type { KnownDriveItem } from "./import-types";
import type { DriveRow } from "./types";
import { canEditDrive, DRIVE_MAX_DEPTH, DRIVE_MAX_FILE_BYTES } from "./utils";

type Db = ReturnType<typeof getDb>;

/** 15 columns x 6 rows = 90 bound parameters, under D1's limit of 100. */
const FOLDERS_PER_INSERT = 6;
/** Bound parameters one statement may use on D1. */
const MAX_PARAMS = 100;
/** Levels of ancestors one request walks. A folder nested deeper counts as not found, which keeps a request far below D1's 50 queries per invocation. */
export const MAX_ANCESTOR_LEVELS = 24;

/**
 * Finds or creates the folders of `paths` below `parentId` (null = the root of `ownerId`'s Drive): one query per 90
 * distinct names finds every folder of the owner with such a name, matched to its parent in memory (so the number of
 * queries does not grow with depth), and the rows of everything new go in batched inserts. The caller keeps a request
 * to MAX_IMPORT_FOLDERS distinct folders. An existing folder is the oldest one (not trashed) with that name; repeating
 * a call changes nothing. A path whose segments are not already import names (see importName), or that would nest past
 * MAX_ANCESTOR_LEVELS (deeper folders could not be found again by the file route) under a parent that is `parentDepth` folders deep, is reported in `errors` and skipped.
 */
export async function ensureImportFolders(db: Db, ownerId: string, parentId: string | null, parentDepth: number, paths: string[][]): Promise<ImportFolderResult> {
	const result: ImportFolderResult = { folders: {}, errors: {} };
	const valid: string[][] = [];
	for (const path of paths) {
		const key = path.join("/");
		if (path.some((segment) => importName(segment) !== segment)) result.errors[key] = "Folder name is not valid";
		else if (parentDepth + path.length > MAX_ANCESTOR_LEVELS) result.errors[key] = NESTED_TOO_DEEPLY;
		else valid.push(path);
	}
	const keyOf = (parent: string | null, name: string) => `${parent ?? ""}/${name}`;
	/** `${parent id}/${name}` to the oldest folder with that name. */
	const resolved = new Map<string, string>();
	for (const part of chunk([...new Set(valid.flat())], SELECT_CHUNK)) {
		const found = await db.select({ id: driveItems.id, parentId: driveItems.parentId, name: driveItems.name })
			.from(driveItems)
			.where(and(eq(driveItems.ownerId, ownerId), eq(driveItems.kind, "folder"), isNull(driveItems.trashedAt), inArray(driveItems.name, part)))
			.orderBy(asc(driveItems.createdAt), asc(driveItems.id));
		for (const row of found) if (!resolved.has(keyOf(row.parentId, row.name))) resolved.set(keyOf(row.parentId, row.name), row.id);
	}
	const rows: (typeof driveItems.$inferInsert)[] = [];
	const now = new Date();
	for (const path of valid) {
		let parent = parentId;
		for (const name of path) {
			let id = resolved.get(keyOf(parent, name));
			if (!id) {
				id = newId("drv");
				resolved.set(keyOf(parent, name), id);
				rows.push({ id, ownerId, parentId: parent, kind: "folder", name, r2Key: null, size: 0, contentType: "application/x-directory", uploadId: null, uploadPartSize: null, uploadFingerprint: null, linkToken: null, trashedAt: null, createdAt: now, updatedAt: now });
			}
			parent = id;
		}
		result.folders[path.join("/")] = parent!;
	}
	const statements = chunk(rows, FOLDERS_PER_INSERT).map((part) => db.insert(driveItems).values(part));
	for (const batch of chunk(statements, STATEMENTS_PER_BATCH)) await db.batch(batch as never);
	return result;
}

/**
 * The owner and depth (the folder and its ancestors) of each of `folderIds` that `userId` may edit, by folder id; anything else (missing, not a folder, in the
 * trash, no edit role, nested deeper than MAX_ANCESTOR_LEVELS) is left out, so the caller cannot tell them apart.
 * The folders come in one query and each further level of ancestors in one more, shared by every folder of the call;
 * a share lookup per 90 ancestors is only made for folders owned by somebody else. The role rules are those of getDriveRole.
 */
export async function findEditableFolders(db: Db, userId: string, folderIds: string[]): Promise<Map<string, { ownerId: string; depth: number }>> {
	const rows = new Map<string, DriveRow>();
	let wanted = [...new Set(folderIds)];
	for (let level = 0; wanted.length > 0 && level < MAX_ANCESTOR_LEVELS; level += 1) {
		for (const row of await db.select().from(driveItems).where(inArray(driveItems.id, wanted))) rows.set(row.id, row);
		wanted = [...new Set(wanted.flatMap((id) => rows.get(id)?.parentId ?? []).filter((id) => !rows.has(id)))];
	}
	const unwalked = new Set(wanted);
	/** The folder and its ancestors, nearest first; null when the walk was cut short. */
	const chainOf = (id: string): DriveRow[] | null => {
		const chain: DriveRow[] = [];
		for (let row = rows.get(id); row && chain.length < DRIVE_MAX_DEPTH; row = row.parentId ? rows.get(row.parentId) : undefined) {
			chain.push(row);
			if (row.parentId && unwalked.has(row.parentId)) return null;
		}
		return chain;
	};
	const candidates = new Map<string, DriveRow[]>();
	for (const id of new Set(folderIds)) {
		const chain = chainOf(id);
		if (chain?.[0]?.kind === "folder" && !chain.some((row) => row.trashedAt)) candidates.set(id, chain);
	}
	const shared = new Set<string>();
	const shareIds = [...new Set([...candidates.values()].filter((chain) => chain[0].ownerId !== userId).flatMap((chain) => chain.map((row) => row.id)))];
	for (const part of chunk(shareIds, SELECT_CHUNK)) {
		for (const share of await db.select({ itemId: driveShares.itemId, role: driveShares.role }).from(driveShares).where(and(eq(driveShares.userId, userId), inArray(driveShares.itemId, part)))) if (share.role === "edit") shared.add(share.itemId);
	}
	const owners = new Map<string, { ownerId: string; depth: number }>();
	for (const [id, chain] of candidates) {
		const role = chain[0].ownerId === userId ? "owner" : chain.some((row) => shared.has(row.id)) ? "edit" : null;
		if (canEditDrive(role)) owners.set(id, { ownerId: chain[0].ownerId, depth: chain.length });
	}
	return owners;
}

type NameGroup = Map<string, KnownDriveItem[]>;

/**
 * Plans each file: skip, upload under a name, or error (see planImportFile). Exact names of the whole batch are looked
 * up first, for every folder at once (one query per 74 names); the first clash loads, in the same way, all `name (n)`
 * candidates of every name (one query per 74 names, by pattern), so a whole request costs a handful of queries however
 * many clashes it holds. Files are planned in order and an earlier file's name counts for the later ones, so two files
 * of one request never take the same name. Inputs name at most 25 folders, which keeps every statement under 100 parameters.
 */
export async function planImportFiles(db: Db, inputs: ImportFileInput[]): Promise<ImportFileOutcome[]> {
	const valid = (input: ImportFileInput) => importName(input.name) === input.name && Number.isInteger(input.size) && input.size >= 0 && input.size <= DRIVE_MAX_FILE_BYTES && input.fingerprint.length > 0 && input.fingerprint.length <= 100;
	const usable = inputs.filter(valid);
	/** A folder, or the top of one owner's Drive, to the items known in it by name. */
	const groups = new Map<string, NameGroup>();
	const groupKey = (folderId: string | null, ownerId: string) => folderId ?? `root:${ownerId}`;
	const groupOf = (input: ImportFileInput) => {
		const key = groupKey(input.folderId, input.ownerId);
		if (!groups.has(key)) groups.set(key, new Map());
		return groups.get(key)!;
	};
	/** Each file name of the request to the folders it is going into. */
	const wantedBy = new Map<string, Set<NameGroup>>();
	for (const input of usable) wantedBy.set(input.name, (wantedBy.get(input.name) ?? new Set()).add(groupOf(input)));
	const folderIds = [...new Set(usable.flatMap((input) => input.folderId ?? []))];
	const rootOwners = [...new Set(usable.filter((input) => input.folderId === null).map((input) => input.ownerId))];
	const scope = or(folderIds.length ? inArray(driveItems.parentId, folderIds) : undefined, rootOwners.length ? and(isNull(driveItems.parentId), inArray(driveItems.ownerId, rootOwners)) : undefined);
	const perQuery = Math.max(1, MAX_PARAMS - folderIds.length - rootOwners.length);

	/**
	 * Looks up `names` in chunks, in every folder of the request at once. `settles` lists the names a chunk makes known
	 * for a folder; only those are filled from the rows, so a name settled earlier is never counted twice.
	 */
	async function load(names: string[], match: (part: string[]) => ReturnType<typeof inArray>, settles: (name: string) => string[]) {
		for (const part of chunk(names, perQuery)) {
			const fresh = new Set<KnownDriveItem[]>();
			for (const name of part) for (const group of wantedBy.get(name)!) for (const settled of settles(name)) {
				if (group.has(settled)) continue;
				const list: KnownDriveItem[] = [];
				group.set(settled, list);
				fresh.add(list);
			}
			const found = await db.select({ ownerId: driveItems.ownerId, parentId: driveItems.parentId, name: driveItems.name, kind: driveItems.kind, size: driveItems.size, uploadId: driveItems.uploadId, fingerprint: driveItems.uploadFingerprint, trashedAt: driveItems.trashedAt })
				.from(driveItems)
				.where(and(scope, match(part)));
			for (const row of found) {
				const list = groups.get(groupKey(row.parentId, row.ownerId))?.get(row.name);
				if (list && fresh.has(list)) list.push({ kind: row.kind, size: row.size, pending: row.uploadId !== null, fingerprint: row.fingerprint, trashed: row.trashedAt !== null });
			}
		}
	}
	const names = [...wantedBy.keys()];
	await load(names, (part) => inArray(driveItems.name, part), (name) => [name]);
	let clashesLoaded = false;
	const outcomes: ImportFileOutcome[] = [];
	for (const input of inputs) {
		if (!valid(input)) { outcomes.push({ action: "error", error: "File name, size or fingerprint is not valid" }); continue; }
		const known = groupOf(input);
		let plan = planImportFile(known, input);
		if (plan.action === "unknown" && !clashesLoaded) {
			clashesLoaded = true;
			await load(names, (part) => or(...part.map((name) => sql`${driveItems.name} like ${collisionPattern(name)} escape '!'`))!, collisionCandidates);
			plan = planImportFile(known, input);
		}
		if (plan.action === "unknown") plan = { action: "error", error: "Too many files with this name" };
		if (plan.action === "upload") known.get(plan.name)?.push({ kind: "file", size: input.size, pending: false, fingerprint: null, trashed: false });
		outcomes.push(plan);
	}
	return outcomes;
}

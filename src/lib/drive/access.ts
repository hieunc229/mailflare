import { and, eq, inArray } from "drizzle-orm";
import { getDb } from "@/db";
import { driveItems, driveShares, driveUploadParts, users } from "@/db/schema";
import { DRIVE_MAX_DEPTH, driveObjectKey } from "./utils";
import type { DriveItemDto, DriveRole, DriveRow } from "./types";

type Db = ReturnType<typeof getDb>;

export async function getDriveItem(db: Db, id: string): Promise<DriveRow | null> {
	const [item] = await db.select().from(driveItems).where(eq(driveItems.id, id)).limit(1);
	return item ?? null;
}

/** Ancestors from the root down to (and including) the item. Stops early at a missing parent. */
export async function getDriveChain(db: Db, item: DriveRow): Promise<DriveRow[]> {
	const chain: DriveRow[] = [item];
	let current = item;
	while (current.parentId && chain.length < DRIVE_MAX_DEPTH) {
		const parent = await getDriveItem(db, current.parentId);
		if (!parent) break;
		chain.unshift(parent);
		current = parent;
	}
	return chain;
}

/**
 * Effective role for a user. Shares on any ancestor apply to everything beneath it. A trashed item or
 * trashed ancestor is invisible unless `allowTrashed` (used by the owner's Trash view).
 */
export async function getDriveRole(db: Db, userId: string, item: DriveRow, allowTrashed = false): Promise<DriveRole | null> {
	const chain = await getDriveChain(db, item);
	if (!allowTrashed && chain.some((entry) => entry.trashedAt)) return null;
	if (item.ownerId === userId) return "owner";
	const shares = await db.select({ role: driveShares.role }).from(driveShares).where(and(eq(driveShares.userId, userId), inArray(driveShares.itemId, chain.map((entry) => entry.id))));
	if (shares.some((share) => share.role === "edit")) return "edit";
	return shares.length ? "view" : null;
}

/** Resolves a public link token to its root item, optionally narrowed to a descendant file. */
export async function getPublicDriveItem(db: Db, token: string, itemId?: string | null): Promise<{ root: DriveRow; item: DriveRow } | null> {
	const [root] = await db.select().from(driveItems).where(eq(driveItems.linkToken, token)).limit(1);
	if (!root || root.trashedAt) return null;
	// A hidden Drive turns its shared links off too, so a blocked owner cannot use them either.
	const [owner] = await db.select({ driveEnabled: users.driveEnabled }).from(users).where(eq(users.id, root.ownerId)).limit(1);
	if (owner && !owner.driveEnabled) return null;
	if (!itemId || itemId === root.id) return { root, item: root };
	const item = await getDriveItem(db, itemId);
	if (!item) return null;
	const chain = await getDriveChain(db, item);
	if (chain.some((entry) => entry.trashedAt) || !chain.some((entry) => entry.id === root.id)) return null;
	return { root, item };
}

export async function toDriveItemDtos(db: Db, rows: DriveRow[], userId: string, roleFor?: (row: DriveRow) => DriveRole): Promise<DriveItemDto[]> {
	if (!rows.length) return [];
	const ownerIds = [...new Set(rows.map((row) => row.ownerId))];
	const owners = await db.select({ id: users.id, name: users.name, email: users.email, avatarKey: users.avatarKey }).from(users).where(inArray(users.id, ownerIds));
	const ownerNames = new Map(owners.map((owner) => [owner.id, owner.name || owner.email]));
	const ownerAvatars = new Map(owners.map((owner) => [owner.id, !!owner.avatarKey]));
	const sharedIds = new Set<string>();
	for (let index = 0; index < rows.length; index += 50) {
		const slice = rows.slice(index, index + 50).map((row) => row.id);
		const shares = await db.select({ itemId: driveShares.itemId }).from(driveShares).where(inArray(driveShares.itemId, slice));
		for (const share of shares) sharedIds.add(share.itemId);
	}
	return rows.map((row) => ({
		id: row.id,
		kind: row.kind,
		name: row.name,
		size: row.size,
		contentType: row.contentType,
		parentId: row.parentId,
		ownerId: row.ownerId,
		ownerName: ownerNames.get(row.ownerId) ?? "",
		ownerHasAvatar: ownerAvatars.get(row.ownerId) ?? false,
		role: roleFor ? roleFor(row) : row.ownerId === userId ? "owner" : "view",
		shared: sharedIds.has(row.id) || !!row.linkToken,
		linkToken: row.ownerId === userId ? row.linkToken : null,
		trashedAt: row.trashedAt?.toISOString() ?? null,
		updatedAt: row.updatedAt.toISOString(),
	}));
}

/** Every descendant of the given folders (breadth first), without the roots themselves. */
export async function collectDriveDescendants(db: Db, rootIds: string[]): Promise<DriveRow[]> {
	const found: DriveRow[] = [];
	let level = rootIds;
	for (let depth = 0; level.length && depth < DRIVE_MAX_DEPTH; depth += 1) {
		const next: DriveRow[] = [];
		for (let index = 0; index < level.length; index += 50) {
			next.push(...await db.select().from(driveItems).where(inArray(driveItems.parentId, level.slice(index, index + 50))));
		}
		found.push(...next);
		level = next.filter((row) => row.kind === "folder").map((row) => row.id);
	}
	return found;
}

/** Permanently removes items, their descendants and the stored objects. */
export async function deleteDriveItems(env: CloudflareEnv, roots: DriveRow[]): Promise<void> {
	const db = getDb(env);
	const descendants = await collectDriveDescendants(db, roots.filter((row) => row.kind === "folder").map((row) => row.id));
	const all = [...roots, ...descendants];
	const keys = all.filter((row) => row.kind === "file").map((row) => row.r2Key ?? driveObjectKey(row.ownerId, row.id));
	for (let index = 0; index < keys.length; index += 500) await env.BUCKET.delete(keys.slice(index, index + 500));
	const ids = all.map((row) => row.id);
	for (let index = 0; index < ids.length; index += 50) {
		const slice = ids.slice(index, index + 50);
		await db.delete(driveShares).where(inArray(driveShares.itemId, slice));
		await db.delete(driveUploadParts).where(inArray(driveUploadParts.itemId, slice));
		await db.delete(driveItems).where(inArray(driveItems.id, slice));
	}
}

/** Drops rows that sit under a trashed folder; only the folder itself carries `trashedAt`. */
export async function withoutTrashedAncestors(db: Db, rows: DriveRow[]): Promise<DriveRow[]> {
	const trashedByFolder = new Map<string, boolean>();
	async function isHidden(folderId: string | null): Promise<boolean> {
		const path: string[] = [];
		let current = folderId;
		let hidden = false;
		while (current && path.length < DRIVE_MAX_DEPTH) {
			const known = trashedByFolder.get(current);
			if (known !== undefined) { hidden = known; break; }
			const folder = await getDriveItem(db, current);
			path.push(current);
			if (!folder) break;
			if (folder.trashedAt) { hidden = true; break; }
			current = folder.parentId;
		}
		for (const id of path) trashedByFolder.set(id, hidden);
		return hidden;
	}
	const kept: DriveRow[] = [];
	for (const row of rows) if (!(await isHidden(row.parentId))) kept.push(row);
	return kept;
}

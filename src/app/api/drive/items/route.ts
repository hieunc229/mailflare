import { and, desc, eq, isNotNull, isNull, or } from "drizzle-orm";
import { NextResponse } from "next/server";
import { driveItems, driveShares } from "@/db/schema";
import { newId } from "@/lib/ids";
import { authorizeDrive } from "@/lib/drive/auth";
import { getDriveChain, getDriveItem, getDriveRole, toDriveItemDtos, withoutTrashedAncestors } from "@/lib/drive/access";
import { canEditDrive, normalizeDriveName, toDriveCrumbs } from "@/lib/drive/utils";
import { driveTypesCondition, parseDriveCategories } from "@/lib/drive/categories";
import { listDriveAttachments } from "@/lib/drive/attachments";
import { getDriveStorageLimit, getDriveStorageUsed } from "@/lib/drive/storage";
import type { DriveRole } from "@/lib/drive/types";
import { containsLike } from "@/db/sql";

export async function GET(request: Request) {
	const auth = await authorizeDrive(request);
	if (auth.error) return auth.error;
	const { env, db, user } = auth;
	const url = new URL(request.url);
	const view = url.searchParams.get("view") ?? "my";
	const parentId = url.searchParams.get("parent");
	const query = url.searchParams.get("q")?.trim();
	const types = parseDriveCategories(url.searchParams.get("types"));
	// With a type filter, files must match but folders stay listed so you can still browse into them.
	const typeFilter = types.length ? or(eq(driveItems.kind, "folder"), driveTypesCondition(types))! : undefined;

	const meta = { storageUsed: await getDriveStorageUsed(db, user.id), storageLimit: await getDriveStorageLimit(env) };
	const respond = (items: Awaited<ReturnType<typeof toDriveItemDtos>>, extra: { path?: ReturnType<typeof toDriveCrumbs>; role: DriveRole }) => NextResponse.json({ items, path: extra.path ?? [], role: extra.role, ...meta });

	if (parentId) {
		const folder = await getDriveItem(db, parentId);
		const role = folder?.kind === "folder" ? await getDriveRole(db, user.id, folder) : null;
		if (!folder || !role) return NextResponse.json({ error: "Folder not found" }, { status: 404 });
		const rows = await db.select().from(driveItems).where(and(eq(driveItems.parentId, folder.id), isNull(driveItems.trashedAt), isNull(driveItems.uploadId), typeFilter));
		const chain = await getDriveChain(db, folder);
		// For shared folders the breadcrumb starts at the folder the user was given access to.
		const visibleChain = role === "owner" ? chain : await trimToSharedRoot(db, user.id, chain);
		return respond(await toDriveItemDtos(db, rows, user.id, () => role), { path: toDriveCrumbs(visibleChain), role });
	}

	if (view === "attachments") return respond(await listDriveAttachments(db, user, types), { role: "view" });

	if (view === "shared") {
		const rows = await db
			.select({ item: driveItems, role: driveShares.role })
			.from(driveShares)
			.innerJoin(driveItems, eq(driveShares.itemId, driveItems.id))
			.where(and(eq(driveShares.userId, user.id), isNull(driveItems.trashedAt), isNull(driveItems.uploadId), typeFilter))
			.orderBy(desc(driveShares.createdAt));
		const roles = new Map(rows.map((row) => [row.item.id, row.role as DriveRole]));
		return respond(await toDriveItemDtos(db, rows.map((row) => row.item), user.id, (row) => roles.get(row.id) ?? "view"), { role: "view" });
	}

	if (view === "trash") {
		const rows = await db.select().from(driveItems).where(and(eq(driveItems.ownerId, user.id), isNotNull(driveItems.trashedAt), typeFilter)).orderBy(desc(driveItems.trashedAt));
		const trashedAttachments = await listDriveAttachments(db, user, types, true);
		const merged = [...await toDriveItemDtos(db, rows, user.id), ...trashedAttachments].sort((a, b) => (b.trashedAt ?? "").localeCompare(a.trashedAt ?? ""));
		return respond(merged, { role: "owner" });
	}

	// My Drive. A type filter, like a search, looks through every folder instead of only the top level.
	if (types.length && !query) {
		const rows = await db.select().from(driveItems).where(and(eq(driveItems.ownerId, user.id), eq(driveItems.kind, "file"), isNull(driveItems.trashedAt), isNull(driveItems.uploadId), driveTypesCondition(types))).orderBy(desc(driveItems.updatedAt)).limit(1000);
		return respond(await toDriveItemDtos(db, await withoutTrashedAncestors(db, rows), user.id), { role: "owner" });
	}
	const conditions = [eq(driveItems.ownerId, user.id), isNull(driveItems.trashedAt), isNull(driveItems.uploadId)];
	if (query) conditions.push(containsLike(driveItems.name, query));
	else conditions.push(isNull(driveItems.parentId));
	if (typeFilter) conditions.push(typeFilter);
	const rows = await db.select().from(driveItems).where(and(...conditions)).orderBy(desc(driveItems.updatedAt)).limit(query ? 200 : 1000);
	return respond(await toDriveItemDtos(db, rows, user.id), { role: "owner" });
}

async function trimToSharedRoot(db: Parameters<typeof getDriveRole>[0], userId: string, chain: Awaited<ReturnType<typeof getDriveChain>>) {
	for (let index = 0; index < chain.length; index += 1) {
		const [share] = await db.select({ id: driveShares.id }).from(driveShares).where(and(eq(driveShares.itemId, chain[index].id), eq(driveShares.userId, userId))).limit(1);
		if (share) return chain.slice(index);
	}
	return chain;
}

/** Creates a folder. */
export async function POST(request: Request) {
	const auth = await authorizeDrive(request, true);
	if (auth.error) return auth.error;
	const { db, user } = auth;
	const body = await request.json().catch(() => ({})) as { name?: unknown; parentId?: unknown };
	const name = normalizeDriveName(body.name);
	if (!name) return NextResponse.json({ error: "Enter a folder name" }, { status: 400 });
	let ownerId = user.id;
	let parentId: string | null = null;
	if (typeof body.parentId === "string" && body.parentId) {
		const parent = await getDriveItem(db, body.parentId);
		const role = parent?.kind === "folder" ? await getDriveRole(db, user.id, parent) : null;
		if (!parent || !canEditDrive(role)) return NextResponse.json({ error: "Folder not found" }, { status: 404 });
		parentId = parent.id;
		ownerId = parent.ownerId;
	}
	const now = new Date();
	const row = { id: newId("drv"), ownerId, parentId, kind: "folder" as const, name, r2Key: null, size: 0, contentType: "application/x-directory", uploadId: null, uploadPartSize: null, uploadFingerprint: null, linkToken: null, trashedAt: null, createdAt: now, updatedAt: now };
	await db.insert(driveItems).values(row);
	const [item] = await toDriveItemDtos(db, [row], user.id, () => (ownerId === user.id ? "owner" : "edit"));
	return NextResponse.json({ item });
}

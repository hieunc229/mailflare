import { NextResponse } from "next/server";
import { and, eq, isNotNull, isNull, lt } from "drizzle-orm";
import { driveItems, driveUploadParts } from "@/db/schema";
import { newId } from "@/lib/ids";
import { authorizeDrive } from "@/lib/drive/auth";
import { getDriveItem, getDriveRole, toDriveItemDtos } from "@/lib/drive/access";
import { getDriveStorageLimit, getDriveStorageUsed } from "@/lib/drive/storage";
import { isVercelRuntime } from "@/lib/runtime";
import { canEditDrive, DRIVE_MAX_FILE_BYTES, DRIVE_MAX_PARTS, DRIVE_PART_BYTES, DRIVE_UPLOAD_RESUME_MS, DRIVE_VERCEL_PART_BYTES, driveObjectKey, normalizeDriveName } from "@/lib/drive/utils";

/**
 * Starts an upload. The file itself is then sent as raw (non multipart/form-data) PUT requests, because the runtime
 * treats every multipart POST as a server action and rejects bodies over 1 MB.
 */
export async function POST(request: Request) {
	const auth = await authorizeDrive(request, true);
	if (auth.error) return auth.error;
	const { env, db, user } = auth;
	const body = await request.json().catch(() => ({})) as { name?: unknown; size?: unknown; contentType?: unknown; parentId?: unknown; fingerprint?: unknown };
	const size = typeof body.size === "number" && Number.isInteger(body.size) && body.size >= 0 ? body.size : null;
	const name = normalizeDriveName(body.name) ?? "Untitled";
	if (size === null) return NextResponse.json({ error: "Invalid file size" }, { status: 400 });
	const newPartBytes = isVercelRuntime(env) ? DRIVE_VERCEL_PART_BYTES : DRIVE_PART_BYTES;
	if (size > DRIVE_MAX_FILE_BYTES || Math.ceil(size / newPartBytes) > DRIVE_MAX_PARTS) return NextResponse.json({ error: "File is too large" }, { status: 413 });

	let ownerId = user.id;
	let parentId: string | null = null;
	if (typeof body.parentId === "string" && body.parentId) {
		const parent = await getDriveItem(db, body.parentId);
		const role = parent?.kind === "folder" ? await getDriveRole(db, user.id, parent) : null;
		if (!parent || !canEditDrive(role)) return NextResponse.json({ error: "Folder not found" }, { status: 404 });
		parentId = parent.id;
		ownerId = parent.ownerId;
	}

	const fingerprint = typeof body.fingerprint === "string" ? body.fingerprint.slice(0, 100) : "";

	// Uploads nobody came back to are discarded so they do not pile up.
	const stale = await db.select().from(driveItems).where(and(eq(driveItems.ownerId, ownerId), isNotNull(driveItems.uploadId), lt(driveItems.updatedAt, new Date(Date.now() - DRIVE_UPLOAD_RESUME_MS)))).limit(20);
	for (const old of stale) {
		await env.BUCKET.resumeMultipartUpload(old.r2Key ?? driveObjectKey(old.ownerId, old.id), old.uploadId!).abort().catch(() => undefined);
		await db.delete(driveUploadParts).where(eq(driveUploadParts.itemId, old.id));
		await db.delete(driveItems).where(eq(driveItems.id, old.id));
	}

	// The same file picked again continues the upload that was interrupted.
	if (fingerprint && size > 0) {
		const [pending] = await db.select().from(driveItems).where(and(eq(driveItems.ownerId, ownerId), parentId ? eq(driveItems.parentId, parentId) : isNull(driveItems.parentId), eq(driveItems.name, name), eq(driveItems.size, size), eq(driveItems.uploadFingerprint, fingerprint), isNotNull(driveItems.uploadId))).limit(1);
		if (pending?.uploadPartSize) {
			const done = await db.select({ partNumber: driveUploadParts.partNumber }).from(driveUploadParts).where(eq(driveUploadParts.itemId, pending.id));
			await db.update(driveItems).set({ updatedAt: new Date() }).where(eq(driveItems.id, pending.id));
			return NextResponse.json({ id: pending.id, partSize: pending.uploadPartSize, parts: Math.ceil(size / pending.uploadPartSize), uploaded: done.map((part) => part.partNumber), resumed: true });
		}
	}

	const limit = await getDriveStorageLimit(env);
	if (limit !== null && (await getDriveStorageUsed(db, ownerId)) + size > limit) return NextResponse.json({ error: "Not enough Drive storage left for this file" }, { status: 413 });

	const id = newId("drv");
	const key = driveObjectKey(ownerId, id);
	const contentType = typeof body.contentType === "string" && body.contentType ? body.contentType.slice(0, 255) : "application/octet-stream";
	const now = new Date();
	const row: typeof driveItems.$inferSelect = { id, ownerId, parentId, kind: "file", name, r2Key: key, size, contentType, uploadId: null, uploadPartSize: null, uploadFingerprint: null, linkToken: null, trashedAt: null, createdAt: now, updatedAt: now };
	const role = ownerId === user.id ? "owner" : "edit";

	// Multipart uploads need at least one part, so an empty file is simply stored.
	if (size === 0) {
		await env.BUCKET.put(key, new Uint8Array(0), { httpMetadata: { contentType } });
		try { await db.insert(driveItems).values(row); }
		catch (error) { await env.BUCKET.delete(key); throw error; }
		const [item] = await toDriveItemDtos(db, [row], user.id, () => role);
		return NextResponse.json({ item, complete: true });
	}

	const upload = await env.BUCKET.createMultipartUpload(key, { httpMetadata: { contentType } });
	row.uploadId = upload.uploadId;
	row.uploadPartSize = newPartBytes;
	row.uploadFingerprint = fingerprint || null;
	try { await db.insert(driveItems).values(row); }
	catch (error) { await upload.abort(); throw error; }
	return NextResponse.json({ id, partSize: newPartBytes, parts: Math.ceil(size / newPartBytes), uploaded: [] });
}

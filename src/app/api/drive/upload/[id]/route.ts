import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { driveItems, driveUploadParts } from "@/db/schema";
import { authorizeDrive } from "@/lib/drive/auth";
import { getDriveItem, getDriveRole, toDriveItemDtos } from "@/lib/drive/access";
import { canEditDrive, DRIVE_MAX_PARTS, DRIVE_PART_BYTES, driveObjectKey } from "@/lib/drive/utils";
import { resolveUploadedRequest } from "@/lib/uploads/direct";
import type { DriveItemParams } from "../../items/[id]/types";

async function loadPending(request: Request, params: DriveItemParams["params"]) {
	const { id } = await params;
	const auth = await authorizeDrive(request, true);
	if (auth.error) return { error: auth.error } as const;
	const item = await getDriveItem(auth.db, id);
	const role = item ? await getDriveRole(auth.db, auth.user.id, item) : null;
	if (!item || !item.uploadId || !canEditDrive(role)) return { error: NextResponse.json({ error: "Upload not found" }, { status: 404 }) } as const;
	const upload = auth.env.BUCKET.resumeMultipartUpload(item.r2Key ?? driveObjectKey(item.ownerId, item.id), item.uploadId);
	return { ...auth, item, upload, role: role! } as const;
}

/** Uploads one part. The body is the raw bytes of the part. */
export async function PUT(request: Request, { params }: DriveItemParams) {
	const ctx = await loadPending(request, params);
	if (ctx.error) return ctx.error;
	const partNumber = Number(new URL(request.url).searchParams.get("part"));
	const body = await resolveUploadedRequest(ctx.env, request, ctx.user.id, DRIVE_PART_BYTES);
	const length = Number(body.headers.get("content-length"));
	const partSize = ctx.item.uploadPartSize ?? 0;
	const total = partSize ? Math.ceil(ctx.item.size / partSize) : 0;
	if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > Math.min(total, DRIVE_MAX_PARTS)) return NextResponse.json({ error: "Invalid part number" }, { status: 400 });
	// R2 needs every part but the last to be the same size, and the size the client declared must add up.
	const expected = partNumber < total ? partSize : ctx.item.size - (total - 1) * partSize;
	if (!body.body || length !== expected) return NextResponse.json({ error: "Invalid part size" }, { status: 400 });
	const part = await ctx.upload.uploadPart(partNumber, body.body);
	await ctx.db.insert(driveUploadParts).values({ itemId: ctx.item.id, partNumber, etag: part.etag }).onConflictDoUpdate({ target: [driveUploadParts.itemId, driveUploadParts.partNumber], set: { etag: part.etag } });
	await ctx.db.update(driveItems).set({ updatedAt: new Date() }).where(eq(driveItems.id, ctx.item.id));
	return NextResponse.json({ partNumber, etag: part.etag });
}

/** Finishes the upload from the recorded parts and makes the file visible. */
export async function POST(request: Request, { params }: DriveItemParams) {
	const ctx = await loadPending(request, params);
	if (ctx.error) return ctx.error;
	const parts = await ctx.db.select({ partNumber: driveUploadParts.partNumber, etag: driveUploadParts.etag }).from(driveUploadParts).where(eq(driveUploadParts.itemId, ctx.item.id));
	const total = ctx.item.uploadPartSize ? Math.ceil(ctx.item.size / ctx.item.uploadPartSize) : 0;
	if (!total || parts.length !== total) return NextResponse.json({ error: "Some parts are missing" }, { status: 409 });
	let object;
	try { object = await ctx.upload.complete(parts); }
	catch { return NextResponse.json({ error: "Could not complete the upload" }, { status: 400 }); }
	const row = { ...ctx.item, size: object.size, uploadId: null, uploadPartSize: null, uploadFingerprint: null, updatedAt: new Date() };
	await ctx.db.update(driveItems).set({ size: row.size, uploadId: null, uploadPartSize: null, uploadFingerprint: null, updatedAt: row.updatedAt }).where(eq(driveItems.id, ctx.item.id));
	await ctx.db.delete(driveUploadParts).where(eq(driveUploadParts.itemId, ctx.item.id));
	const [item] = await toDriveItemDtos(ctx.db, [row], ctx.user.id, () => ctx.role);
	return NextResponse.json({ item });
}

/** Abandons an upload and discards what was sent. */
export async function DELETE(request: Request, { params }: DriveItemParams) {
	const ctx = await loadPending(request, params);
	if (ctx.error) return ctx.error;
	await ctx.upload.abort().catch(() => undefined);
	await ctx.db.delete(driveUploadParts).where(eq(driveUploadParts.itemId, ctx.item.id));
	await ctx.db.delete(driveItems).where(eq(driveItems.id, ctx.item.id));
	return NextResponse.json({ ok: true });
}

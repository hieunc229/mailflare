import { NextResponse } from "next/server";
import { driveItems } from "@/db/schema";
import { newId } from "@/lib/ids";
import { authorizeDrive } from "@/lib/drive/auth";
import { toDriveItemDtos } from "@/lib/drive/access";
import { getDriveStorageLimit, getDriveStorageUsed } from "@/lib/drive/storage";
import { DRIVE_MAX_FILE_BYTES, driveObjectKey, normalizeDriveName } from "@/lib/drive/utils";
import { getAttachmentForUser } from "@/lib/email/attachments";
import type { SaveToDriveRouteParams } from "./types";

/**
 * Copies an attachment into the user's own Drive at the root. The object is duplicated rather
 * than shared so deleting the message cannot break the Drive file, and repeat saves create
 * distinct items, exactly like uploading the same file twice.
 */
export async function POST(request: Request, { params }: SaveToDriveRouteParams) {
	const auth = await authorizeDrive(request, true);
	if (auth.error) return auth.error;
	const { env, db, user } = auth;

	const { attachmentId, messageId } = await params;
	const result = await getAttachmentForUser(env, user, messageId, attachmentId);
	if (!result) return NextResponse.json({ error: "Not found" }, { status: 404 });
	const { attachment, object } = result;
	if (attachment.size > DRIVE_MAX_FILE_BYTES) return NextResponse.json({ error: "File is too large" }, { status: 413 });

	const limit = await getDriveStorageLimit(env);
	if (limit !== null && (await getDriveStorageUsed(db, user.id)) + attachment.size > limit) {
		return NextResponse.json({ error: "Not enough Drive storage left for this file" }, { status: 413 });
	}

	const id = newId("drv");
	const key = driveObjectKey(user.id, id);
	await env.BUCKET.put(key, object.body, { httpMetadata: { contentType: attachment.contentType } });

	const now = new Date();
	const row: typeof driveItems.$inferSelect = {
		id,
		ownerId: user.id,
		parentId: null,
		kind: "file",
		name: normalizeDriveName(attachment.filename) ?? "attachment",
		r2Key: key,
		size: attachment.size,
		contentType: attachment.contentType,
		uploadId: null,
		uploadPartSize: null,
		uploadFingerprint: null,
		linkToken: null,
		trashedAt: null,
		createdAt: now,
		updatedAt: now,
	};
	try {
		await db.insert(driveItems).values(row);
	} catch (error) {
		await env.BUCKET.delete(key);
		throw error;
	}
	const [item] = await toDriveItemDtos(db, [row], user.id, () => "owner");
	return NextResponse.json({ item });
}

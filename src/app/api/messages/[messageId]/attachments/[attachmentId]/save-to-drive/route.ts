import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { driveItems } from "@/db/schema";
import { newId } from "@/lib/ids";
import { authorizeDrive } from "@/lib/drive/auth";
import { toDriveItemDtos } from "@/lib/drive/access";
import { getDriveStorageLimit, getDriveStorageUsed } from "@/lib/drive/storage";
import { DRIVE_MAX_FILE_BYTES, normalizeDriveName } from "@/lib/drive/utils";
import { getAttachmentForUser } from "@/lib/email/attachments";
import type { SaveToDriveRouteParams } from "./types";

/** The user's Drive item that already points at this attachment's object, if any. */
async function findSavedItem(db: Parameters<typeof toDriveItemDtos>[0], ownerId: string, r2Key: string) {
	const [row] = await db
		.select()
		.from(driveItems)
		.where(and(eq(driveItems.ownerId, ownerId), eq(driveItems.r2Key, r2Key), eq(driveItems.kind, "file")))
		.limit(1);
	return row ?? null;
}

/** Whether this attachment is already in the user's Drive, so the viewer can disable the button. */
export async function GET(request: Request, { params }: SaveToDriveRouteParams) {
	const auth = await authorizeDrive(request, false);
	if (auth.error) return auth.error;
	const { env, db, user } = auth;

	const { attachmentId, messageId } = await params;
	const result = await getAttachmentForUser(env, user, messageId, attachmentId);
	if (!result) return NextResponse.json({ error: "Not found" }, { status: 404 });
	const row = await findSavedItem(db, user.id, result.attachment.r2Key);
	if (!row || row.trashedAt) return NextResponse.json({ saved: false });
	return NextResponse.json({ saved: true, itemId: row.id });
}

/**
 * Adds an attachment to the user's own Drive at the root without copying it: the Drive item points
 * at the attachment's stored object, so one file backs both. The object is only removed once
 * neither the email attachment nor a Drive item uses it (see `deleteUnreferencedObjects`), so
 * deleting either side never breaks the other. Saving again returns the existing item, and a copy
 * the user trashed is restored.
 */
export async function POST(request: Request, { params }: SaveToDriveRouteParams) {
	const auth = await authorizeDrive(request, true);
	if (auth.error) return auth.error;
	const { env, db, user } = auth;

	const { attachmentId, messageId } = await params;
	const result = await getAttachmentForUser(env, user, messageId, attachmentId);
	if (!result) return NextResponse.json({ error: "Not found" }, { status: 404 });
	const { attachment } = result;

	const existing = await findSavedItem(db, user.id, attachment.r2Key);
	if (existing) {
		let row = existing;
		if (existing.trashedAt) {
			row = { ...existing, trashedAt: null, updatedAt: new Date() };
			await db.update(driveItems).set({ trashedAt: null, updatedAt: row.updatedAt }).where(eq(driveItems.id, existing.id));
		}
		const [item] = await toDriveItemDtos(db, [row], user.id, () => "owner");
		return NextResponse.json({ item, alreadySaved: true });
	}

	if (attachment.size > DRIVE_MAX_FILE_BYTES) return NextResponse.json({ error: "File is too large" }, { status: 413 });
	const limit = await getDriveStorageLimit(env);
	if (limit !== null && (await getDriveStorageUsed(db, user.id)) + attachment.size > limit) {
		return NextResponse.json({ error: "Not enough Drive storage left for this file" }, { status: 413 });
	}

	const now = new Date();
	const row: typeof driveItems.$inferSelect = {
		id: newId("drv"),
		ownerId: user.id,
		parentId: null,
		kind: "file",
		name: normalizeDriveName(attachment.filename) ?? "attachment",
		r2Key: attachment.r2Key,
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
	await db.insert(driveItems).values(row);
	const [item] = await toDriveItemDtos(db, [row], user.id, () => "owner");
	return NextResponse.json({ item });
}

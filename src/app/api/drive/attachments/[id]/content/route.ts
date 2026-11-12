import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { messageAttachments } from "@/db/schema";
import { getEnv } from "@/lib/cloudflare";
import { requireSessionUser } from "@/lib/api/auth";
import { getAttachmentForUser } from "@/lib/email/attachments";
import { driveAccessError } from "@/lib/drive/auth";
import { streamDriveFile } from "@/lib/drive/content";
import type { DriveRow } from "@/lib/drive/types";
import type { DriveItemParams } from "../../../items/[id]/types";

/** Streams an email attachment for the Drive preview, with range support and a CSP that lets PDFs render. */
export async function GET(request: Request, { params }: DriveItemParams) {
	const { id } = await params;
	const env = getEnv();
	const { user, error } = await requireSessionUser(env, request);
	if (error) return error;
	const denied = driveAccessError(user);
	if (denied) return denied;
	const [row] = await getDb(env).select({ messageId: messageAttachments.messageId }).from(messageAttachments).where(eq(messageAttachments.id, id)).limit(1);
	const result = row ? await getAttachmentForUser(env, user, row.messageId, id) : null;
	if (!result) return new Response("Not found", { status: 404 });
	const { attachment } = result;
	const file: DriveRow = { id: attachment.id, ownerId: row.messageId, parentId: null, kind: "file", name: attachment.filename, r2Key: attachment.r2Key, size: attachment.size, contentType: attachment.contentType, uploadId: null, uploadPartSize: null, uploadFingerprint: null, linkToken: null, trashedAt: null, createdAt: attachment.createdAt, updatedAt: attachment.createdAt };
	return streamDriveFile(env, request, file, new URL(request.url).searchParams.get("download") === "1");
}

import { and, eq, isNull } from "drizzle-orm";
import { getDb } from "@/db";
import { messageAttachments, messages } from "@/db/schema";
import { getCurrentUser } from "@/lib/auth/cookies";
import { getEnv } from "@/lib/cloudflare";
import { getMailboxAccessLevel } from "@/lib/mailboxes/access";
import { createZipStream } from "@/lib/zip";
import { assessStoredAttachment } from "@/lib/email/attachments";
import { getAttachmentContentDisposition } from "../attachments/[attachmentId]/utils";
import { attachmentsZipName } from "./utils";
import type { AttachmentsZipRouteParams } from "./types";

/** Streams every attachment of a message as one ZIP; objects are fetched one at a time. */
export async function GET(request: Request, { params }: AttachmentsZipRouteParams) {
	const env = getEnv();
	const user = await getCurrentUser(env, request);
	if (!user) return new Response("Unauthorized", { status: 401 });

	const { messageId } = await params;
	const db = getDb(env);
	const [message] = await db
		.select({ mailboxId: messages.mailboxId, userId: messages.userId, subject: messages.subject })
		.from(messages)
		.where(eq(messages.id, messageId))
		.limit(1);
	if (!message) return new Response("Not found", { status: 404 });
	if (message.mailboxId) {
		const access = await getMailboxAccessLevel(db, user, message.mailboxId);
		if (!access?.canRead) return new Response("Not found", { status: 404 });
	} else if (message.userId !== user.id) {
		return new Response("Not found", { status: 404 });
	}

	const rows = await db
		.select({
			filename: messageAttachments.filename,
			r2Key: messageAttachments.r2Key,
			contentType: messageAttachments.contentType,
			size: messageAttachments.size,
		})
		.from(messageAttachments)
		.where(and(eq(messageAttachments.messageId, messageId), isNull(messageAttachments.trashedAt)));
	if (!rows.length) return new Response("Message has no attachments", { status: 404 });

	// Same gate the per-attachment download applies: flagged files need an explicit
	// acknowledgement before the archive may stream them.
	const risks = await Promise.all(
		rows.map((row) => assessStoredAttachment(env, { filename: row.filename, type: row.contentType, size: row.size, r2Key: row.r2Key })),
	);
	const flagged = rows.filter((_, index) => risks[index]?.level !== "ok").map((row) => row.filename);
	if (flagged.length && new URL(request.url).searchParams.get("acknowledge") !== "1") {
		return Response.json(
			{ error: "Some attachments are flagged. Review the warning before downloading them.", flagged },
			{ status: 409, headers: { "Cache-Control": "private, no-store" } },
		);
	}

	// A missing object must not silently produce a partial archive.
	const heads = await Promise.all(rows.map((row) => env.BUCKET.head(row.r2Key)));
	const missing = rows.filter((_, index) => !heads[index]).map((row) => row.filename);
	if (missing.length) {
		return Response.json(
			{ error: `${missing.length} attachment(s) are missing from storage`, missing },
			{ status: 404, headers: { "Cache-Control": "private, no-store" } },
		);
	}

	const stream = createZipStream(rows.map((row) => ({
		name: row.filename,
		open: async () => (await env.BUCKET.get(row.r2Key))?.body ?? null,
	})));

	return new Response(stream, {
		headers: {
			"Content-Type": "application/zip",
			"Content-Disposition": getAttachmentContentDisposition(attachmentsZipName(message.subject), false),
			"Cache-Control": "private, no-store",
			"X-Content-Type-Options": "nosniff",
		},
	});
}

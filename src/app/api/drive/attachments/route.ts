import { eq, inArray } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { messageAttachments, messages } from "@/db/schema";
import { authorizeDrive } from "@/lib/drive/auth";
import { getMailboxAccessLevel, hasMailboxPermission } from "@/lib/mailboxes/access";
import { deleteUnreferencedObjects } from "@/lib/drive/shared-objects";

const MAX_BULK = 200;

/**
 * Trash, restore or permanently delete email attachments.
 *
 * - `trash` hides the attachment from the email and lists it in the Drive trash; it is purged after 30 days.
 * - `restore` puts it back on the email.
 * - `delete` removes the database row and the stored file for good, and only works on trashed attachments.
 *
 * The message itself is never touched. Read-only mailbox access is not enough for any of these.
 */
export async function POST(request: Request) {
	const auth = await authorizeDrive(request, true);
	if (auth.error) return auth.error;
	const { env, user } = auth;
	const db = getDb(env);
	const body = await request.json().catch(() => ({})) as { action?: unknown; ids?: unknown };
	const ids = Array.isArray(body.ids) ? [...new Set(body.ids.filter((id): id is string => typeof id === "string"))] : [];
	if (body.action !== "trash" && body.action !== "restore" && body.action !== "delete") return NextResponse.json({ error: "Unknown action" }, { status: 400 });
	if (!ids.length || ids.length > MAX_BULK) return NextResponse.json({ error: "Select between 1 and 200 attachments" }, { status: 400 });

	const permitted: { id: string; r2Key: string; trashedAt: Date | null }[] = [];
	const accessCache = new Map<string, boolean>();
	let denied = 0;
	for (let index = 0; index < ids.length; index += 50) {
		const rows = await db
			.select({ id: messageAttachments.id, r2Key: messageAttachments.r2Key, trashedAt: messageAttachments.trashedAt, mailboxId: messages.mailboxId, userId: messages.userId })
			.from(messageAttachments)
			.innerJoin(messages, eq(messageAttachments.messageId, messages.id))
			.where(inArray(messageAttachments.id, ids.slice(index, index + 50)));
		for (const row of rows) {
			let allowed: boolean;
			if (!row.mailboxId) allowed = row.userId === user.id;
			else {
				if (!accessCache.has(row.mailboxId)) {
					const access = await getMailboxAccessLevel(db, user, row.mailboxId);
					accessCache.set(row.mailboxId, !!access && hasMailboxPermission(access.permission, "send_on_behalf"));
				}
				allowed = accessCache.get(row.mailboxId)!;
			}
			if (allowed) permitted.push({ id: row.id, r2Key: row.r2Key, trashedAt: row.trashedAt }); else denied += 1;
		}
	}
	if (denied && !permitted.length) return NextResponse.json({ error: "You cannot change these attachments" }, { status: 403 });

	let targets = permitted;
	if (body.action === "trash") targets = permitted.filter((row) => !row.trashedAt);
	else targets = permitted.filter((row) => row.trashedAt);
	const targetIds = targets.map((row) => row.id);

	for (let index = 0; index < targetIds.length; index += 50) {
		const slice = targetIds.slice(index, index + 50);
		if (body.action === "delete") await db.delete(messageAttachments).where(inArray(messageAttachments.id, slice));
		else await db.update(messageAttachments).set({ trashedAt: body.action === "trash" ? new Date() : null }).where(inArray(messageAttachments.id, slice));
	}
	if (body.action === "delete" && targets.length) await deleteUnreferencedObjects(env, db, targets.map((row) => row.r2Key), { attachmentIds: targetIds });
	return NextResponse.json({ count: targets.length, denied });
}

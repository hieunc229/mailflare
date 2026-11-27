import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { getDb } from "@/db";
import { folders } from "@/db/schema";
import { requireSessionUser } from "@/lib/api/auth";
import { getEnv } from "@/lib/cloudflare";
import { normalizeTrashRetentionDays } from "@/lib/email/trash-retention-utils";
import { updateFolderRetentionSettingsSchema } from "@/lib/validators";
import { getMailboxFolderAccess } from "../../utils";

type Params = { params: Promise<{ id: string }> };

/**
 * Per-folder retention settings. Reading needs access to the folder's mailbox; changing it needs the same
 * "manage" right folder creation does. The scheduled purge (src/lib/email/trash-retention.ts) only reads
 * folders.retentionDays, so this route is the one place the rule is written.
 *
 * What setting `days` does: the scheduled purge deletes filed mail in this folder — `received` or `archived`,
 * and not `direction: "outbound"` — whose message date (`messages.createdAt`) is older than `days`. It never
 * deletes drafts, sent copies (a completed send filed here keeps `direction: "outbound"`, and imported Sent
 * mail does too), Trash/Spam (those follow the owner's Trash retention), mail a live outbound job still owns,
 * or any status outside that list. The message date is the `Date` header on imported mail, not the import time, so
 * importing an old mailbox makes that mail eligible on the next scheduled run — there is no grace period,
 * by design (retention is about the age of the mail, not when it arrived here). `null` removes the rule and
 * the folder falls back to the owner's Trash/Spam retention.
 */
export async function GET(request: Request, { params }: Params) {
	const { id } = await params;
	const env = getEnv();
	const auth = await requireSessionUser(env, request);
	if (auth.error) return auth.error;

	const db = getDb(env);
	const [folder] = await db.select().from(folders).where(eq(folders.id, id)).limit(1);
	if (!folder) return NextResponse.json({ error: "Folder not found" }, { status: 404 });
	const access = await getMailboxFolderAccess(db, auth.user, folder.mailboxId);
	if (!access) return NextResponse.json({ error: "Folder not found" }, { status: 404 });

	return NextResponse.json({ folderId: folder.id, days: normalizeTrashRetentionDays(folder.retentionDays) });
}

export async function PATCH(request: Request, { params }: Params) {
	const { id } = await params;
	const env = getEnv();
	const auth = await requireSessionUser(env, request);
	if (auth.error) return auth.error;

	let days: number | null;
	try {
		days = updateFolderRetentionSettingsSchema.parse(await request.json()).days;
	} catch (error) {
		return NextResponse.json({ error: error instanceof ZodError ? error.flatten() : "Invalid request" }, { status: 400 });
	}

	const db = getDb(env);
	const [folder] = await db.select().from(folders).where(eq(folders.id, id)).limit(1);
	if (!folder) return NextResponse.json({ error: "Folder not found" }, { status: 404 });
	const access = await getMailboxFolderAccess(db, auth.user, folder.mailboxId);
	if (!access?.canManage) return NextResponse.json({ error: "Folder not found" }, { status: 404 });

	await db.update(folders).set({ retentionDays: days }).where(eq(folders.id, folder.id));
	return NextResponse.json({ folderId: folder.id, days });
}

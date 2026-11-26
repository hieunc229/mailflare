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

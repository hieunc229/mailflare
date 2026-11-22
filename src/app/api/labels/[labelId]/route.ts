import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { getCurrentUser } from "@/lib/auth/cookies";
import { getEnv } from "@/lib/cloudflare";
import { isMissingTableError } from "@/lib/database-errors";
import { readJsonObject } from "@/lib/http/request";
import { deleteLabel, findLabel, updateLabel } from "@/lib/labels/service";
import { getMailboxAccessLevel } from "@/lib/mailboxes/access";
import { z } from "zod";
import { FOLDER_COLOR_VALUES } from "@/lib/folders/colors";
import { migrationRequired } from "@/app/api/messages/[messageId]/notes/utils";

type RouteContext = { params: Promise<{ labelId: string }> };

const labelPatchSchema = z.object({
	name: z.string().trim().min(1).max(80).optional(),
	color: z.enum(FOLDER_COLOR_VALUES).optional(),
});

/** The label, when the user has full access to its mailbox; otherwise the response to send. */
async function loadManagedLabel(request: Request, labelId: string) {
	const env = getEnv();
	const user = await getCurrentUser(env, request);
	if (!user) return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
	const db = getDb(env);
	const label = await findLabel(db, labelId);
	const access = label ? await getMailboxAccessLevel(db, user, label.mailboxId) : null;
	if (!label || !access?.canRead) return { error: NextResponse.json({ error: "Label not found" }, { status: 404 }) };
	if (!access.canManage) return { error: NextResponse.json({ error: "You cannot change labels in this mailbox" }, { status: 403 }) };
	return { db, label };
}

export async function PATCH(request: Request, context: RouteContext) {
	const parsed = labelPatchSchema.safeParse(await readJsonObject(request));
	if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
	try {
		const loaded = await loadManagedLabel(request, (await context.params).labelId);
		if ("error" in loaded) return loaded.error;
		const label = await updateLabel(loaded.db, loaded.label, parsed.data);
		if (label === "duplicate") return NextResponse.json({ error: "Label already exists" }, { status: 409 });
		return NextResponse.json({ label });
	} catch (error) {
		if (isMissingTableError(error)) return migrationRequired();
		throw error;
	}
}

export async function DELETE(request: Request, context: RouteContext) {
	try {
		const loaded = await loadManagedLabel(request, (await context.params).labelId);
		if ("error" in loaded) return loaded.error;
		await deleteLabel(loaded.db, loaded.label.id);
		return NextResponse.json({ ok: true });
	} catch (error) {
		if (isMissingTableError(error)) return migrationRequired();
		throw error;
	}
}

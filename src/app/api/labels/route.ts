import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { getCurrentUser } from "@/lib/auth/cookies";
import { getEnv } from "@/lib/cloudflare";
import { isMissingTableError } from "@/lib/database-errors";
import { readJsonObject } from "@/lib/http/request";
import { createLabel, listLabels } from "@/lib/labels/service";
import { getMailboxAccessLevel } from "@/lib/mailboxes/access";
import { folderSchema } from "@/lib/validators";
import { migrationRequired } from "@/app/api/messages/[messageId]/notes/utils";

/** The labels of one mailbox. A database without the labels migration has none. */
export async function GET(request: Request) {
	const env = getEnv();
	const user = await getCurrentUser(env, request);
	if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
	const mailboxId = new URL(request.url).searchParams.get("mailboxId");
	if (!mailboxId) return NextResponse.json({ labels: [] });
	const db = getDb(env);
	const access = await getMailboxAccessLevel(db, user, mailboxId);
	if (!access?.canRead) return NextResponse.json({ error: "Mailbox not found" }, { status: 404 });
	try {
		return NextResponse.json({ labels: await listLabels(db, [mailboxId]) });
	} catch (error) {
		if (isMissingTableError(error)) return NextResponse.json({ labels: [] });
		throw error;
	}
}

/** Creating a label takes full access to the mailbox, like creating a folder. Same name and colour rules too. */
export async function POST(request: Request) {
	const env = getEnv();
	const user = await getCurrentUser(env, request);
	if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
	const parsed = folderSchema.safeParse(await readJsonObject(request));
	if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
	const db = getDb(env);
	const access = await getMailboxAccessLevel(db, user, parsed.data.mailboxId);
	if (!access?.canRead) return NextResponse.json({ error: "Mailbox not found" }, { status: 404 });
	if (!access.canManage) return NextResponse.json({ error: "You cannot create labels in this mailbox" }, { status: 403 });
	try {
		const label = await createLabel(db, parsed.data.mailboxId, { name: parsed.data.name, color: parsed.data.color });
		if (!label) return NextResponse.json({ error: "Label already exists" }, { status: 409 });
		return NextResponse.json({ label }, { status: 201 });
	} catch (error) {
		if (isMissingTableError(error)) return migrationRequired();
		throw error;
	}
}

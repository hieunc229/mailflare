import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { folders } from "@/db/schema";
import { requireUser } from "@/lib/auth/cookies";
import { getEnv } from "@/lib/cloudflare";
import { newId } from "@/lib/ids";
import { folderSchema } from "@/lib/validators";
import { getMailboxFolderAccess, listFoldersForMailbox } from "./utils";
import { readJsonObject } from "@/lib/http/request";

export async function GET(request: Request) {
	const env = getEnv();
	const user = await requireUser(env, request);
	const url = new URL(request.url);
	const mailboxId = url.searchParams.get("mailboxId");
	if (!mailboxId) {
		return NextResponse.json({ folders: [] });
	}

	const db = getDb(env);
	const access = await getMailboxFolderAccess(db, user, mailboxId);
	if (!access) {
		return NextResponse.json({ error: "Mailbox not found" }, { status: 404 });
	}

	const rows = await listFoldersForMailbox(db, mailboxId);
	return NextResponse.json({ folders: rows });
}

export async function POST(request: Request) {
	const env = getEnv();
	const user = await requireUser(env, request);
	const parsed = folderSchema.safeParse(await readJsonObject(request));
	if (!parsed.success) {
		return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
	}

	const db = getDb(env);
	const access = await getMailboxFolderAccess(db, user, parsed.data.mailboxId);
	if (!access?.canManage) {
		return NextResponse.json({ error: "Mailbox not found" }, { status: 404 });
	}

	const name = parsed.data.name.trim();
	const [existing] = await db
		.select()
		.from(folders)
		.where(and(eq(folders.mailboxId, parsed.data.mailboxId), eq(folders.name, name)))
		.limit(1);
	if (existing) {
		return NextResponse.json({ error: "Folder already exists" }, { status: 409 });
	}

	const id = newId("fld");
	await db.insert(folders).values({
		id,
		userId: access.mailboxUserId,
		mailboxId: parsed.data.mailboxId,
		name,
		color: parsed.data.color,
	});

	return NextResponse.json({ id, mailboxId: parsed.data.mailboxId, name, color: parsed.data.color });
}

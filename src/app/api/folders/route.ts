import { and, eq, ne } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { folders, routingRules } from "@/db/schema";
import { requireSessionUser } from "@/lib/api/auth";
import { requireUser } from "@/lib/auth/cookies";
import { getEnv } from "@/lib/cloudflare";
import { isUniqueConstraintError } from "@/lib/database-errors";
import { newId } from "@/lib/ids";
import { folderSchema, folderUpdateSchema } from "@/lib/validators";
import { deleteFolderMovingMessagesToInbox, getFolderForMailbox, getMailboxFolderAccess, listFoldersForMailbox } from "./utils";
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

export async function PATCH(request: Request) {
	const env = getEnv();
	const auth = await requireSessionUser(env, request);
	if (auth.error) return auth.error;
	const parsed = folderUpdateSchema.safeParse(await readJsonObject(request));
	if (!parsed.success) {
		return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
	}

	const { id, mailboxId, name, color } = parsed.data;
	const db = getDb(env);
	const access = await getMailboxFolderAccess(db, auth.user, mailboxId);
	if (!access?.canManage) {
		return NextResponse.json({ error: "Mailbox not found" }, { status: 404 });
	}
	if (!(await getFolderForMailbox(db, id, mailboxId))) {
		return NextResponse.json({ error: "Folder not found" }, { status: 404 });
	}

	const [existing] = await db
		.select({ id: folders.id })
		.from(folders)
		.where(and(eq(folders.mailboxId, mailboxId), eq(folders.name, name), ne(folders.id, id)))
		.limit(1);
	if (existing) {
		return NextResponse.json({ error: "Folder already exists" }, { status: 409 });
	}

	try {
		await db.update(folders).set({ name, color }).where(and(eq(folders.id, id), eq(folders.mailboxId, mailboxId)));
	} catch (error) {
		// Lost a race with another rename or create: the unique (mailbox, name) index decides.
		if (isUniqueConstraintError(error)) return NextResponse.json({ error: "Folder already exists" }, { status: 409 });
		throw error;
	}

	return NextResponse.json({ id, mailboxId, name, color });
}

export async function DELETE(request: Request) {
	const env = getEnv();
	const auth = await requireSessionUser(env, request);
	if (auth.error) return auth.error;
	const url = new URL(request.url);
	const id = url.searchParams.get("id");
	const mailboxId = url.searchParams.get("mailboxId");
	if (!id || !mailboxId) {
		return NextResponse.json({ error: "id and mailboxId are required" }, { status: 400 });
	}

	const db = getDb(env);
	const access = await getMailboxFolderAccess(db, auth.user, mailboxId);
	if (!access?.canManage) {
		return NextResponse.json({ error: "Mailbox not found" }, { status: 404 });
	}
	// System folders (inbox, sent, ...) have no row here, so they are never deletable.
	if (!(await getFolderForMailbox(db, id, mailboxId))) {
		return NextResponse.json({ error: "Folder not found" }, { status: 404 });
	}

	// A rule that files into this folder would silently stop filing (the FK clears its folder), so make the user change it first.
	const rules = await db
		.select({ name: routingRules.name, pattern: routingRules.pattern })
		.from(routingRules)
		.where(eq(routingRules.folderId, id));
	if (rules.length) {
		const list = rules.map((rule) => rule.name || rule.pattern).join(", ");
		return NextResponse.json({ error: `Inbox rules still file into this folder: ${list}. Change or delete them first.` }, { status: 409 });
	}

	const moved = await deleteFolderMovingMessagesToInbox(db, { id, mailboxId });
	return NextResponse.json({ ok: true, moved });
}

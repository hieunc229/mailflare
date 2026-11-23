import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { contactGroups } from "@/db/schema";
import { requireUser } from "@/lib/auth/cookies";
import { getEnv } from "@/lib/cloudflare";
import { readJsonObject } from "@/lib/http/request";
import { updateContactGroupSchema } from "@/lib/validators";
import type { ContactGroupRouteParams } from "./types";
import { findGroupNameConflict, getGroupBookOwner, getOwnedGroup, listGroupMembers } from "../utils";

export async function GET(request: Request, { params }: ContactGroupRouteParams) {
	const { id } = await params;
	const env = getEnv();
	const user = await requireUser(env, request);
	const mailboxId = new URL(request.url).searchParams.get("mailboxId");
	if (!mailboxId) {
		return NextResponse.json({ error: "Mailbox is required" }, { status: 400 });
	}

	const db = getDb(env);
	const userId = await getGroupBookOwner(db, user, mailboxId);
	if (!userId) {
		return NextResponse.json({ error: "Mailbox not found" }, { status: 404 });
	}
	const group = await getOwnedGroup(db, userId, id);
	if (!group) return NextResponse.json({ error: "Group not found" }, { status: 404 });

	const members = await listGroupMembers(db, id);
	return NextResponse.json({ group: { ...group, memberCount: members.length }, members });
}

export async function PATCH(request: Request, { params }: ContactGroupRouteParams) {
	const { id } = await params;
	const env = getEnv();
	const user = await requireUser(env, request);
	const parsed = updateContactGroupSchema.safeParse(await readJsonObject(request));
	if (!parsed.success) {
		return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
	}

	const db = getDb(env);
	const userId = await getGroupBookOwner(db, user, parsed.data.mailboxId);
	if (!userId) {
		return NextResponse.json({ error: "Mailbox not found" }, { status: 404 });
	}
	const group = await getOwnedGroup(db, userId, id);
	if (!group) return NextResponse.json({ error: "Group not found" }, { status: 404 });

	if (parsed.data.name === undefined || parsed.data.name === group.name) {
		return NextResponse.json({ error: "Nothing to update" }, { status: 400 });
	}
	if (await findGroupNameConflict(db, userId, parsed.data.name, id)) {
		return NextResponse.json({ error: "A group with this name already exists" }, { status: 409 });
	}
	await db.update(contactGroups).set({ name: parsed.data.name }).where(eq(contactGroups.id, group.id));

	const [updated] = await db.select().from(contactGroups).where(eq(contactGroups.id, group.id)).limit(1);
	return NextResponse.json({ group: updated });
}

export async function DELETE(request: Request, { params }: ContactGroupRouteParams) {
	const { id } = await params;
	const env = getEnv();
	const user = await requireUser(env, request);
	const mailboxId = new URL(request.url).searchParams.get("mailboxId");
	if (!mailboxId) {
		return NextResponse.json({ error: "Mailbox is required" }, { status: 400 });
	}

	const db = getDb(env);
	const userId = await getGroupBookOwner(db, user, mailboxId);
	if (!userId) {
		return NextResponse.json({ error: "Mailbox not found" }, { status: 404 });
	}
	const group = await getOwnedGroup(db, userId, id);
	if (!group) return NextResponse.json({ error: "Group not found" }, { status: 404 });

	// Members cascade with the group; the contacts it labelled do not.
	await db.delete(contactGroups).where(eq(contactGroups.id, group.id));
	return NextResponse.json({ ok: true });
}

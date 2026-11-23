import { asc, count, eq, inArray, sql } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { contactGroupMembers, contactGroups } from "@/db/schema";
import { requireUser } from "@/lib/auth/cookies";
import { getEnv } from "@/lib/cloudflare";
import { readJsonObject } from "@/lib/http/request";
import { newId } from "@/lib/ids";
import { contactGroupSchema } from "@/lib/validators";
import { findGroupNameConflict, getGroupBookOwner } from "./utils";

export async function GET(request: Request) {
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

	const groups = await db
		.select()
		.from(contactGroups)
		.where(eq(contactGroups.userId, userId))
		.orderBy(asc(sql`lower(${contactGroups.name})`), asc(contactGroups.id));
	const memberCounts = new Map(
		groups.length === 0
			? []
			: (await db
					.select({ groupId: contactGroupMembers.groupId, total: count() })
					.from(contactGroupMembers)
					.where(inArray(contactGroupMembers.groupId, groups.map((group) => group.id)))
					.groupBy(contactGroupMembers.groupId)
				).map((row) => [row.groupId, row.total]),
	);
	return NextResponse.json({
		groups: groups.map((group) => ({ ...group, memberCount: memberCounts.get(group.id) ?? 0 })),
	});
}

export async function POST(request: Request) {
	const env = getEnv();
	const user = await requireUser(env, request);
	const parsed = contactGroupSchema.safeParse(await readJsonObject(request));
	if (!parsed.success) {
		return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
	}

	const db = getDb(env);
	const userId = await getGroupBookOwner(db, user, parsed.data.mailboxId);
	if (!userId) {
		return NextResponse.json({ error: "Mailbox not found" }, { status: 404 });
	}
	if (await findGroupNameConflict(db, userId, parsed.data.name)) {
		return NextResponse.json({ error: "A group with this name already exists" }, { status: 409 });
	}

	const id = newId("cg");
	await db.insert(contactGroups).values({ id, userId, name: parsed.data.name });
	const [group] = await db.select().from(contactGroups).where(eq(contactGroups.id, id)).limit(1);
	return NextResponse.json({ group: { ...group!, memberCount: 0 } });
}

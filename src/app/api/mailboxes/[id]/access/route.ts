import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { mailboxAccess, users } from "@/db/schema";
import { requireTeamSharingAdmin } from "@/app/api/accounts/utils";
import { newId } from "@/lib/ids";
import { mailboxAccessSchema } from "@/lib/validators";
import type { MailboxAccessRouteParams } from "./types";
import { getSharedMailboxForAdmin } from "./utils";

export async function GET(request: Request, { params }: MailboxAccessRouteParams) {
	const access = await requireTeamSharingAdmin(request);
	if (access.error) return access.error;
	const { id } = await params;
	const db = getDb(access.env);
	const mailbox = await getSharedMailboxForAdmin(db, id, access.user!.id);
	if (!mailbox) return NextResponse.json({ error: "Shared inbox not found" }, { status: 404 });

	const [members, availableUsers] = await Promise.all([
		db
			.select({
				id: mailboxAccess.id,
				userId: mailboxAccess.userId,
				userEmail: users.email,
				userName: users.name,
				permission: mailboxAccess.permission,
				createdAt: mailboxAccess.createdAt,
			})
			.from(mailboxAccess)
			.innerJoin(users, eq(mailboxAccess.userId, users.id))
			.where(eq(mailboxAccess.mailboxId, id)),
		db
			.select({ id: users.id, email: users.email, name: users.name, role: users.role })
			.from(users)
			.where(and(eq(users.createdByUserId, access.user!.id), eq(users.disabled, false))),
	]);

	return NextResponse.json({ members, availableUsers });
}

export async function POST(request: Request, { params }: MailboxAccessRouteParams) {
	const access = await requireTeamSharingAdmin(request);
	if (access.error) return access.error;
	const parsed = mailboxAccessSchema.safeParse(await request.json().catch(() => null));
	if (!parsed.success) return NextResponse.json({ error: "Choose a valid account" }, { status: 400 });
	const { id } = await params;
	const db = getDb(access.env);
	const mailbox = await getSharedMailboxForAdmin(db, id, access.user!.id);
	if (!mailbox) return NextResponse.json({ error: "Shared inbox not found" }, { status: 404 });
	const [user] = await db
		.select({ id: users.id })
		.from(users)
		.where(and(eq(users.id, parsed.data.userId), eq(users.createdByUserId, access.user!.id), eq(users.disabled, false)))
		.limit(1);
	if (!user) return NextResponse.json({ error: "Account not found" }, { status: 404 });

	await db
		.insert(mailboxAccess)
		.values({
			id: newId("mac"),
			mailboxId: id,
			userId: user.id,
			permission: parsed.data.permission,
			createdByUserId: access.user!.id,
		})
		.onConflictDoUpdate({
			target: [mailboxAccess.mailboxId, mailboxAccess.userId],
			set: { permission: parsed.data.permission, createdByUserId: access.user!.id },
		});
	return NextResponse.json({ ok: true });
}

export async function DELETE(request: Request, { params }: MailboxAccessRouteParams) {
	const access = await requireTeamSharingAdmin(request);
	if (access.error) return access.error;
	const { id } = await params;
	const userId = new URL(request.url).searchParams.get("userId");
	if (!userId) return NextResponse.json({ error: "Account is required" }, { status: 400 });
	const db = getDb(access.env);
	const mailbox = await getSharedMailboxForAdmin(db, id, access.user!.id);
	if (!mailbox) return NextResponse.json({ error: "Shared inbox not found" }, { status: 404 });
	await db
		.delete(mailboxAccess)
		.where(and(eq(mailboxAccess.mailboxId, id), eq(mailboxAccess.userId, userId)));
	return NextResponse.json({ ok: true });
}

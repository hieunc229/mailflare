import { NextResponse } from "next/server";
import { and, eq, or } from "drizzle-orm";
import { getEnv } from "@/lib/cloudflare";
import { getDb } from "@/db";
import { mailboxes, users } from "@/db/schema";
import { authenticateAdminApiKey } from "@/lib/api/admin-auth";
import { updateMailboxSchema } from "@/lib/validators";
import { getMailboxUpdateValues } from "@/app/api/mailboxes/[id]/utils";
import { ensureMailboxDomainRouting, removeMailboxDomainRouting } from "@/lib/mailboxes/domain-addresses";
import type { AdminMailboxRouteParams } from "./types";

async function managedMailbox(request: Request, id: string) {
	const env = getEnv();
	const auth = await authenticateAdminApiKey(env, request, "mailboxes");
	if (!auth) return { env, mailbox: null, error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
	const [mailbox] = await getDb(env).select({
		id: mailboxes.id, userId: mailboxes.userId, domainId: mailboxes.domainId,
		localPart: mailboxes.localPart, displayName: mailboxes.displayName,
		type: mailboxes.type, disabled: mailboxes.disabled,
		useAllDomains: mailboxes.useAllDomains, createdAt: mailboxes.createdAt,
		autoReplyEnabled: mailboxes.autoReplyEnabled,
		autoReplyStartAt: mailboxes.autoReplyStartAt, autoReplyEndAt: mailboxes.autoReplyEndAt,
	}).from(mailboxes).innerJoin(users, eq(mailboxes.userId, users.id))
		.where(and(eq(mailboxes.id, id), or(eq(users.id, auth.userId), eq(users.createdByUserId, auth.userId)))).limit(1);
	if (!mailbox) return { env, mailbox: null, error: NextResponse.json({ error: "Mailbox not found" }, { status: 404 }) };
	return { env, mailbox, error: null };
}

export async function GET(request: Request, { params }: AdminMailboxRouteParams) {
	const access = await managedMailbox(request, (await params).id);
	if (access.error) return access.error;
	return NextResponse.json({ mailbox: access.mailbox });
}

export async function PATCH(request: Request, { params }: AdminMailboxRouteParams) {
	const access = await managedMailbox(request, (await params).id);
	if (access.error) return access.error;
	const parsed = updateMailboxSchema.safeParse(await request.json().catch(() => null));
	if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
	const db = getDb(access.env);
	const values = getMailboxUpdateValues(parsed.data, { autoReplyEnabled: access.mailbox!.autoReplyEnabled });
	const autoReplyStartAt = "autoReplyStartAt" in values ? values.autoReplyStartAt : access.mailbox!.autoReplyStartAt;
	const autoReplyEndAt = "autoReplyEndAt" in values ? values.autoReplyEndAt : access.mailbox!.autoReplyEndAt;
	if (autoReplyStartAt && autoReplyEndAt && autoReplyStartAt >= autoReplyEndAt) {
		return NextResponse.json({ error: "The auto-reply end must be after its start" }, { status: 400 });
	}
	if (parsed.data.useAllDomains === true) {
		try {
			await ensureMailboxDomainRouting(access.env, db, { id: access.mailbox!.id, domainId: access.mailbox!.domainId, localPart: access.mailbox!.localPart, useAllDomains: true });
		} catch (error) {
			return NextResponse.json({ error: error instanceof Error ? error.message : "Failed to configure inbound routing" }, { status: 502 });
		}
	}
	if (Object.keys(values).length) await db.update(mailboxes).set(values).where(eq(mailboxes.id, access.mailbox!.id));
	return NextResponse.json({ ok: true });
}

export async function DELETE(request: Request, { params }: AdminMailboxRouteParams) {
	const access = await managedMailbox(request, (await params).id);
	if (access.error) return access.error;
	const db = getDb(access.env);
	try {
		await removeMailboxDomainRouting(access.env, db, access.mailbox!);
	} catch (error) {
		return NextResponse.json({ error: error instanceof Error ? error.message : "Failed to remove Cloudflare routing rule" }, { status: 502 });
	}
	await db.delete(mailboxes).where(eq(mailboxes.id, access.mailbox!.id));
	return NextResponse.json({ ok: true });
}

import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { getEnv } from "@/lib/cloudflare";
import { getDb } from "@/db";
import { routingRules } from "@/db/schema";
import { requireUser } from "@/lib/auth/cookies";
import { newId } from "@/lib/ids";
import { getMailboxAccessLevel } from "@/lib/mailboxes/access";
import { routingRuleSchema } from "@/lib/validators";
import { resolveRuleTarget } from "./utils";

export async function GET(request: Request) {
	const env = getEnv();
	const user = await requireUser(env, request);
	const url = new URL(request.url);
	const mailboxId = url.searchParams.get("mailboxId");
	if (!mailboxId) {
		return NextResponse.json({ rules: [] });
	}

	const db = getDb(env);
	const access = await getMailboxAccessLevel(db, user, mailboxId);
	if (!access?.canManage) {
		return NextResponse.json({ error: "Mailbox not found" }, { status: 404 });
	}

	const rows = await db
		.select()
		.from(routingRules)
		.where(and(eq(routingRules.mailboxId, mailboxId), eq(routingRules.scope, "mailbox")));
	return NextResponse.json({ rules: rows });
}

export async function POST(request: Request) {
	const env = getEnv();
	const user = await requireUser(env, request);
	const parsed = routingRuleSchema.safeParse(await request.json());
	if (!parsed.success) {
		return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
	}

	const db = getDb(env);
	const access = await getMailboxAccessLevel(db, user, parsed.data.mailboxId);
	if (!access?.canManage) {
		return NextResponse.json({ error: "Mailbox not found" }, { status: 404 });
	}
	const mailbox = access.mailbox;

	const target = await resolveRuleTarget(db, mailbox.id, parsed.data);
	if ("error" in target) {
		return NextResponse.json({ error: target.error }, { status: target.status });
	}

	const id = newId("rule");
	await db.insert(routingRules).values({
		id,
		userId: user.id,
		domainId: mailbox.domainId,
		scope: "mailbox",
		pattern: parsed.data.matchValue.trim(),
		matchField: parsed.data.matchField,
		matchOperator: parsed.data.matchOperator,
		matchValue: parsed.data.matchValue.trim(),
		action: target.action,
		mailboxId: mailbox.id,
		folderId: target.folderId,
		forwardTo: target.forwardTo,
		keepCopy: target.keepCopy,
		priority: parsed.data.priority,
	});

	return NextResponse.json({ id, ...parsed.data });
}

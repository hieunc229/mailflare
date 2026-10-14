import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { routingRules } from "@/db/schema";
import { requireSessionUser } from "@/lib/api/auth";
import { getEnv } from "@/lib/cloudflare";
import { newId } from "@/lib/ids";
import { domainRoutingRuleSchema } from "@/lib/validators";
import {
	assertAdminRuleMailbox,
	getAdminDomain,
	listAdminDomainMailboxes,
	listAdminRoutingDomains,
	listDomainRules,
	toRuleColumns,
} from "@/lib/domains/routing-rules";
import { hasValidSessionMutationOrigin } from "@/lib/auth/origin";

export async function GET(request: Request) {
	const env = getEnv();
	const auth = await requireSessionUser(env, request);
	if (auth.error) return auth.error;
	const user = auth.user;
	const searchParams = new URL(request.url).searchParams;
	const db = getDb(env);
	if (searchParams.get("list") === "true") {
		const domains = await listAdminRoutingDomains(db, user);
		if (!domains) return NextResponse.json({ error: "Domain management permission is required" }, { status: 403 });
		return NextResponse.json({ domains });
	}
	const domainId = searchParams.get("domainId");
	if (!domainId) {
		return NextResponse.json({ error: "domainId is required" }, { status: 400 });
	}

	const adminDomain = await getAdminDomain(db, user, domainId);
	if (!adminDomain) {
		return NextResponse.json({ error: "Domain management permission is required" }, { status: 403 });
	}

	return NextResponse.json({
		rules: await listDomainRules(db, domainId),
		mailboxes: await listAdminDomainMailboxes(db, domainId),
	});
}

export async function POST(request: Request) {
	const env = getEnv();
	const auth = await requireSessionUser(env, request);
	if (auth.error) return auth.error;
	const user = auth.user;
	if (!hasValidSessionMutationOrigin(request)) return NextResponse.json({ error: "Invalid origin" }, { status: 403 });
	const parsed = domainRoutingRuleSchema.safeParse(await request.json());
	if (!parsed.success) {
		return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
	}

	const db = getDb(env);
	const adminDomain = await getAdminDomain(db, user, parsed.data.domainId);
	if (!adminDomain) {
		return NextResponse.json({ error: "Domain management permission is required" }, { status: 403 });
	}

	const destinationAllowed = parsed.data.mailboxId
		? await assertAdminRuleMailbox(db, parsed.data.mailboxId, parsed.data.domainId)
		: true;
	if (!destinationAllowed) {
		return NextResponse.json({ error: "Mailbox access is required for the destination" }, { status: 403 });
	}

	const id = newId("rule");
	await db.insert(routingRules).values({
		id,
		userId: user.id,
		domainId: parsed.data.domainId,
		...toRuleColumns(parsed.data),
	});

	return NextResponse.json({ id });
}

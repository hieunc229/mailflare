import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { getEnv } from "@/lib/cloudflare";
import { getDb } from "@/db";
import { domains, routingRules } from "@/db/schema";
import { requireUser } from "@/lib/auth/cookies";
import { newId } from "@/lib/ids";
import { routingRuleSchema } from "@/lib/validators";

export async function GET() {
	const env = getEnv();
	const user = await requireUser(env);
	const db = getDb(env);
	const rows = await db.select().from(routingRules).where(eq(routingRules.userId, user.id));
	return NextResponse.json({ rules: rows });
}

export async function POST(request: Request) {
	const env = getEnv();
	const user = await requireUser(env);
	const parsed = routingRuleSchema.safeParse(await request.json());
	if (!parsed.success) {
		return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
	}

	const db = getDb(env);
	const [domain] = await db.select().from(domains).where(eq(domains.id, parsed.data.domainId)).limit(1);
	if (!domain || domain.userId !== user.id) {
		return NextResponse.json({ error: "Domain not found" }, { status: 404 });
	}

	const id = newId("rule");
	await db.insert(routingRules).values({
		id,
		userId: user.id,
		domainId: parsed.data.domainId,
		pattern: parsed.data.pattern,
		action: parsed.data.action,
		mailboxId: parsed.data.mailboxId ?? null,
		forwardTo: parsed.data.forwardTo ?? null,
		priority: parsed.data.priority,
	});

	return NextResponse.json({ id, ...parsed.data });
}

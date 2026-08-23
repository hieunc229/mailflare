import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { getEnv } from "@/lib/cloudflare";
import { getDb } from "@/db";
import { domains, mailboxes } from "@/db/schema";
import { requireUser } from "@/lib/auth/cookies";
import { newId } from "@/lib/ids";
import { mailboxSchema } from "@/lib/validators";
import { ensureEmailRoutingRuleToWorker } from "@/lib/cloudflare-api";
import { listAccessibleMailboxes } from "@/lib/mailboxes/access";

export async function GET(request: Request) {
	const env = getEnv();
	const user = await requireUser(env, request);
	const db = getDb(env);
	const rows = await listAccessibleMailboxes(db, user);
	return NextResponse.json({ mailboxes: rows });
}

export async function POST(request: Request) {
	const env = getEnv();
	const user = await requireUser(env, request);
	const parsed = mailboxSchema.safeParse(await request.json());
	if (!parsed.success) {
		return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
	}

	const db = getDb(env);
	const mailboxType = "personal";
	const [domain] = await db
		.select()
		.from(domains)
		.where(eq(domains.id, parsed.data.domainId))
		.limit(1);
	if (!domain || domain.userId !== user.id) {
		return NextResponse.json({ error: "Domain not found" }, { status: 404 });
	}

	const localPart = parsed.data.localPart.toLowerCase();
	const [existing] = await db
		.select()
		.from(mailboxes)
		.where(and(eq(mailboxes.domainId, domain.id), eq(mailboxes.localPart, localPart)))
		.limit(1);
	if (existing) {
		return NextResponse.json({ error: "Mailbox already exists" }, { status: 409 });
	}

	const address = `${localPart}@${domain.hostname}`;
	try {
		await ensureEmailRoutingRuleToWorker(env, domain.zoneId, address);
	} catch (err) {
		const message = err instanceof Error ? err.message : "Failed to create Cloudflare routing rule";
		return NextResponse.json({ error: message }, { status: 502 });
	}

	const id = newId("mbx");
	await db.insert(mailboxes).values({
		id,
		userId: user.id,
		domainId: parsed.data.domainId,
		localPart,
		displayName: parsed.data.displayName,
		forwardTo: parsed.data.forwardTo,
		type: mailboxType,
	});

	return NextResponse.json({
		id,
		address,
		type: mailboxType,
	});
}

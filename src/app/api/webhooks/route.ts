import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { getEnv } from "@/lib/cloudflare";
import { getDb } from "@/db";
import { webhooks } from "@/db/schema";
import { requireUser } from "@/lib/auth/cookies";
import { newId } from "@/lib/ids";
import { webhookSchema } from "@/lib/validators";

export async function GET() {
	const env = getEnv();
	const user = await requireUser(env);
	const db = getDb(env);
	const rows = await db.select().from(webhooks).where(eq(webhooks.userId, user.id));
	return NextResponse.json({
		webhooks: rows.map((w) => ({ id: w.id, url: w.url, events: w.events, enabled: w.enabled })),
	});
}

export async function POST(request: Request) {
	const env = getEnv();
	const user = await requireUser(env);
	const parsed = webhookSchema.safeParse(await request.json());
	if (!parsed.success) {
		return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
	}

	const secret = newId("whsec");
	const db = getDb(env);
	const id = newId("wh");
	await db.insert(webhooks).values({
		id,
		userId: user.id,
		url: parsed.data.url,
		secret,
		events: JSON.stringify(parsed.data.events),
		enabled: true,
	});

	return NextResponse.json({ id, url: parsed.data.url, secret, events: parsed.data.events });
}

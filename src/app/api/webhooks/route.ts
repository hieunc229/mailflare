import { NextResponse } from "next/server";
import { count, desc, eq, inArray, max } from "drizzle-orm";
import { getEnv } from "@/lib/cloudflare";
import { getDb } from "@/db";
import { webhookDeliveries, webhooks } from "@/db/schema";
import { parseWebhookEvents } from "@/lib/email/webhooks";
import { summariseDeliveryStats } from "./utils";
import { requireSessionUser } from "@/lib/api/auth";
import { isPrimaryAdmin } from "@/lib/auth/admin";
import { newId } from "@/lib/ids";
import { webhookSchema } from "@/lib/validators";
import { readJsonBody } from "@/lib/http/request";
import { RequestBodyTooLargeError } from "@/lib/http/errors";
import { hasValidSessionMutationOrigin } from "@/lib/auth/origin";

export async function GET(request: Request) {
	const env = getEnv();
	const auth = await requireSessionUser(env, request);
	if (auth.error) return auth.error;
	const user = auth.user;
	if (!isPrimaryAdmin(user)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
	const db = getDb(env);
	const rows = await db
		.select()
		.from(webhooks)
		.where(eq(webhooks.userId, user.id))
		.orderBy(desc(webhooks.createdAt));

	// One grouped query gives every endpoint its delivery health without an N+1.
	const stats = await db
		.select({
			webhookId: webhookDeliveries.webhookId,
			status: webhookDeliveries.status,
			total: count(),
			lastAttemptAt: max(webhookDeliveries.lastAttemptAt),
		})
		.from(webhookDeliveries)
		.where(inArray(webhookDeliveries.webhookId, db.select({ id: webhooks.id }).from(webhooks).where(eq(webhooks.userId, user.id))))
		.groupBy(webhookDeliveries.webhookId, webhookDeliveries.status);

	return NextResponse.json({
		webhooks: rows.map((w) => ({
			id: w.id,
			url: w.url,
			description: w.description,
			events: parseWebhookEvents(w.events),
			enabled: w.enabled,
			maxAttempts: w.maxAttempts,
			createdAt: w.createdAt,
			stats: summariseDeliveryStats(stats, w.id),
		})),
	});
}

export async function POST(request: Request) {
	const env = getEnv();
	const auth = await requireSessionUser(env, request);
	if (auth.error) return auth.error;
	const user = auth.user;
	if (!isPrimaryAdmin(user)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
	if (!hasValidSessionMutationOrigin(request)) return NextResponse.json({ error: "Invalid origin" }, { status: 403 });
	let body: unknown;
	try {
		body = await readJsonBody(request, 16 * 1024);
	} catch (error) {
		const status = error instanceof RequestBodyTooLargeError ? 413 : 400;
		return NextResponse.json({ error: "Invalid webhook request" }, { status });
	}
	const parsed = webhookSchema.safeParse(body);
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
		description: parsed.data.description?.trim() || null,
		secret,
		events: JSON.stringify(parsed.data.events),
		enabled: true,
		maxAttempts: parsed.data.maxAttempts,
	});

	// The signing secret is shown once, at creation time, and never returned again.
	return NextResponse.json({ id, url: parsed.data.url, secret, events: parsed.data.events });
}

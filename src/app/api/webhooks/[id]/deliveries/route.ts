import { and, desc, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { webhookDeliveries } from "@/db/schema";
import { loadOwnedWebhook } from "../utils";
import type { WebhookRouteParams } from "../types";
import { parseLimit } from "@/lib/api/query-params";

const MAX_PAYLOAD_PREVIEW = 2000;

export async function GET(request: Request, { params }: WebhookRouteParams) {
	const { id } = await params;
	const loaded = await loadOwnedWebhook(request, id);
	if (loaded.error) return loaded.error;

	const url = new URL(request.url);
	const limit = parseLimit(url.searchParams.get("limit"), 25, 100);
	const status = url.searchParams.get("status");

	const rows = await loaded.db
		.select()
		.from(webhookDeliveries)
		.where(status ? and(eq(webhookDeliveries.webhookId, id), eq(webhookDeliveries.status, status)) : eq(webhookDeliveries.webhookId, id))
		.orderBy(desc(webhookDeliveries.createdAt))
		.limit(limit);

	return NextResponse.json({
		deliveries: rows.map((row) => ({
			id: row.id,
			eventType: row.eventType,
			status: row.status,
			attempts: row.attempts,
			maxAttempts: loaded.hook.maxAttempts,
			responseStatus: row.responseStatus,
			error: row.error,
			durationMs: row.durationMs,
			lastAttemptAt: row.lastAttemptAt,
			nextRetryAt: row.nextRetryAt,
			createdAt: row.createdAt,
			payload: row.payload.slice(0, MAX_PAYLOAD_PREVIEW),
		})),
	});
}

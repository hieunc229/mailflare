import { and, inArray, lt } from "drizzle-orm";
import { getDb } from "@/db";
import { webhookDeliveries } from "@/db/schema";

export const WEBHOOK_DELIVERY_RETENTION_DAYS = 30;
/** Under D1's 100 bound parameters per statement. */
const BATCH_SIZE = 90;
/** Bounds one run; the next day continues a large backlog. */
const MAX_BATCHES = 50;

/**
 * Deletes finished deliveries (delivered, failed, exhausted) older than the retention window.
 * Pending and retrying rows are kept: they may still be attempted. Returns the rows deleted.
 */
export async function purgeOldWebhookDeliveries(env: CloudflareEnv, now = new Date()): Promise<number> {
	const db = getDb(env);
	const cutoff = new Date(now.getTime() - WEBHOOK_DELIVERY_RETENTION_DAYS * 86_400_000);
	let deleted = 0;
	for (let batch = 0; batch < MAX_BATCHES; batch += 1) {
		const old = await db
			.select({ id: webhookDeliveries.id })
			.from(webhookDeliveries)
			.where(and(inArray(webhookDeliveries.status, ["delivered", "failed", "exhausted"]), lt(webhookDeliveries.createdAt, cutoff)))
			.limit(BATCH_SIZE);
		if (old.length === 0) break;
		await db.delete(webhookDeliveries).where(inArray(webhookDeliveries.id, old.map((row) => row.id)));
		deleted += old.length;
		if (old.length < BATCH_SIZE) break;
	}
	return deleted;
}

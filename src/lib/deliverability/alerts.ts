import { and, desc, eq, isNull } from "drizzle-orm";
import { getDb } from "@/db";
import { deliverabilityAlerts } from "@/db/schema";

export type OpenAlert = { id: string; kind: "spoofing" | "auth_regression" | "no_reports"; day: string; detail: unknown; createdAt: string };

const OPEN_LIMIT = 50;

function parseDetail(value: string): unknown {
	try {
		return JSON.parse(value);
	} catch {
		return {};
	}
}

export async function listOpenAlerts(env: CloudflareEnv, domainId: string): Promise<OpenAlert[]> {
	const rows = await getDb(env).select().from(deliverabilityAlerts)
		.where(and(eq(deliverabilityAlerts.domainId, domainId), isNull(deliverabilityAlerts.acknowledgedAt)))
		.orderBy(desc(deliverabilityAlerts.createdAt), desc(deliverabilityAlerts.id))
		.limit(OPEN_LIMIT);
	return rows.map((row) => ({ id: row.id, kind: row.kind, day: row.day, detail: parseDetail(row.detail), createdAt: row.createdAt.toISOString() }));
}

/** Marks one alert of this domain as seen. False when it does not exist, belongs to another domain or was already acknowledged. */
export async function acknowledgeAlert(env: CloudflareEnv, domainId: string, alertId: string, userId: string): Promise<boolean> {
	const updated = await getDb(env).update(deliverabilityAlerts)
		.set({ acknowledgedAt: new Date(), acknowledgedByUserId: userId })
		.where(and(eq(deliverabilityAlerts.id, alertId), eq(deliverabilityAlerts.domainId, domainId), isNull(deliverabilityAlerts.acknowledgedAt)))
		.returning({ id: deliverabilityAlerts.id });
	return updated.length > 0;
}

import { and, count, desc, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { emailSuppressions } from "@/db/schema";
import { containsLike } from "@/db/sql";
import type { SuppressionReason, SuppressionSource } from "./suppression-utils";

export const MAX_SUPPRESSION_PAGE = 100;
const REASONS: SuppressionReason[] = ["hard_bounce", "complaint", "manual"];

export type SuppressionItem = {
	id: string;
	email: string;
	reason: SuppressionReason;
	source: SuppressionSource;
	detail: string | null;
	/** False: recorded from a single returned message (or an ambiguous Resend event) and not enforced yet. */
	confirmed: boolean;
	eventCount: number;
	firstEventAt: Date;
	lastEventAt: Date;
};

export async function listSuppressions(
	env: CloudflareEnv,
	domainId: string,
	query: { q?: string; reason?: string; offset?: number; limit?: number },
): Promise<{ items: SuppressionItem[]; total: number }> {
	const table = emailSuppressions;
	const reason = REASONS.find((value) => value === query.reason);
	const term = query.q?.trim();
	const where = and(
		eq(table.domainId, domainId),
		reason ? eq(table.reason, reason) : undefined,
		term ? containsLike(table.email, term) : undefined,
	);
	const limit = Math.min(Math.max(Math.trunc(query.limit ?? 50) || 50, 1), MAX_SUPPRESSION_PAGE);
	const offset = Math.max(Math.trunc(query.offset ?? 0) || 0, 0);
	const db = getDb(env);
	const [items, [totals]] = await Promise.all([
		db.select({
			id: table.id, email: table.email, reason: table.reason, source: table.source, detail: table.detail, confirmed: table.confirmed,
			eventCount: table.eventCount, firstEventAt: table.firstEventAt, lastEventAt: table.lastEventAt,
		}).from(table).where(where).orderBy(desc(table.lastEventAt), table.email).limit(limit).offset(offset),
		db.select({ total: count() }).from(table).where(where),
	]);
	return { items, total: totals?.total ?? 0 };
}

/** The removed address, or null when the id is not an entry of this domain. */
export async function removeSuppression(env: CloudflareEnv, domainId: string, id: string): Promise<{ email: string } | null> {
	const [removed] = await getDb(env).delete(emailSuppressions)
		.where(and(eq(emailSuppressions.id, id), eq(emailSuppressions.domainId, domainId)))
		.returning({ email: emailSuppressions.email });
	return removed ?? null;
}

/** Makes an entry of this domain enforceable; the address, or null when the id is not an entry of this domain. */
export async function confirmSuppression(env: CloudflareEnv, domainId: string, id: string): Promise<{ email: string } | null> {
	const [confirmed] = await getDb(env).update(emailSuppressions).set({ confirmed: true })
		.where(and(eq(emailSuppressions.id, id), eq(emailSuppressions.domainId, domainId)))
		.returning({ email: emailSuppressions.email });
	return confirmed ?? null;
}

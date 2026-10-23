import { desc, eq, inArray, sql } from "drizzle-orm";
import { getEmailAddress } from "@/lib/email/address";
import { getDb } from "@/db";
import { domains, domainTrackingHosts, messageOpens, messageTracking, messages } from "@/db/schema";
import { newId } from "@/lib/ids";
import { classifyOpen, createTrackingToken, isDuplicateOpen, MAX_STORED_OPENS } from "./open-tracking-utils";
import type { MessageTrackingSummary } from "./types";
import { isMissingTableError } from "@/lib/database-errors";

/** Returns the message's pixel token, creating it on the first delivery attempt. */
export async function ensureTrackingToken(env: CloudflareEnv, messageId: string): Promise<string> {
	const db = getDb(env);
	await db.insert(messageTracking).values({ token: createTrackingToken(), messageId }).onConflictDoNothing();
	const [row] = await db
		.select({ token: messageTracking.token })
		.from(messageTracking)
		.where(eq(messageTracking.messageId, messageId))
		.limit(1);
	if (!row) throw new Error("Could not create the read-receipt token");
	return row.token;
}

/** Records one pixel fetch. Unknown tokens are ignored so the pixel answers the same either way. */
export async function recordOpen(
	env: CloudflareEnv,
	token: string,
	request: { userAgent: string | null; asn?: number; country?: string | null; city?: string | null },
): Promise<void> {
	const db = getDb(env);
	const [tracking] = await db
		.select({ token: messageTracking.token, createdAt: messageTracking.createdAt, direction: messages.direction })
		.from(messageTracking)
		.innerJoin(messages, eq(messages.id, messageTracking.messageId))
		.where(eq(messageTracking.token, token))
		.limit(1);
	if (!tracking || tracking.direction !== "outbound") return;

	const openedAt = new Date();
	const open = classifyOpen({ ...request, sentAt: tracking.createdAt, openedAt });
	const recent = await db
		.select({ openedAt: messageOpens.openedAt, client: messageOpens.client, device: messageOpens.device })
		.from(messageOpens)
		.where(eq(messageOpens.token, token))
		.orderBy(desc(messageOpens.openedAt))
		.limit(MAX_STORED_OPENS);
	if (isDuplicateOpen(recent[0], { openedAt, client: open.client, device: open.device })) return;

	if (recent.length < MAX_STORED_OPENS) {
		await db.insert(messageOpens).values({ id: newId("open"), token, openedAt, ...open });
	}
	if (open.automated) return;
	await db
		.update(messageTracking)
		.set({
			openCount: sql`${messageTracking.openCount} + 1`,
			firstOpenedAt: sql`coalesce(${messageTracking.firstOpenedAt}, ${Math.floor(openedAt.getTime() / 1000)})`,
			lastOpenedAt: openedAt,
		})
		.where(eq(messageTracking.token, token));
}

export async function getMessageTrackingSummary(env: CloudflareEnv, messageId: string): Promise<MessageTrackingSummary | null> {
	const db = getDb(env);
	const [tracking] = await db.select().from(messageTracking).where(eq(messageTracking.messageId, messageId)).limit(1);
	if (!tracking) return null;
	const opens = await db
		.select()
		.from(messageOpens)
		.where(eq(messageOpens.token, tracking.token))
		.orderBy(desc(messageOpens.openedAt))
		.limit(MAX_STORED_OPENS);
	return {
		openCount: tracking.openCount,
		firstOpenedAt: tracking.firstOpenedAt?.toISOString() ?? null,
		lastOpenedAt: tracking.lastOpenedAt?.toISOString() ?? null,
		onlyAutomated: tracking.openCount === 0 && opens.length > 0,
		opens: opens.map((row) => ({
			openedAt: row.openedAt.toISOString(),
			client: row.client,
			device: row.device,
			country: row.country,
			city: row.city,
			automated: row.automated,
		})),
	};
}

/** Open counts for the given messages; messages without a pixel are absent from the map. */
export async function getOpenCounts(env: CloudflareEnv, messageIds: string[]): Promise<Map<string, number>> {
	const counts = new Map<string, number>();
	if (messageIds.length === 0) return counts;
	try {
		const rows = await getDb(env)
			.select({ messageId: messageTracking.messageId, openCount: messageTracking.openCount })
			.from(messageTracking)
			.where(inArray(messageTracking.messageId, messageIds));
		for (const row of rows) counts.set(row.messageId, row.openCount);
	} catch (error) {
		// Lists keep working before migration 0068 is applied.
		if (!isMissingTableError(error)) throw error;
	}
	return counts;
}

/** The pixel hostname configured for the sender's domain, if any. */
export async function getTrackingHostForSender(env: CloudflareEnv, from: string): Promise<string | null> {
	const domain = getEmailAddress(from).split("@")[1]?.toLowerCase();
	if (!domain) return null;
	try {
		const [row] = await getDb(env)
			.select({ hostname: domainTrackingHosts.hostname })
			.from(domainTrackingHosts)
			.innerJoin(domains, eq(domains.id, domainTrackingHosts.domainId))
			.where(eq(domains.hostname, domain))
			.limit(1);
		return row?.hostname ?? null;
	} catch (error) {
		if (isMissingTableError(error)) return null;
		throw error;
	}
}

/** Null when unset; throws `TrackingHostsUnavailableError` before migration 0069. */
export async function getDomainTrackingHost(env: CloudflareEnv, domainId: string): Promise<string | null> {
	try {
		const [row] = await getDb(env)
			.select({ hostname: domainTrackingHosts.hostname })
			.from(domainTrackingHosts)
			.where(eq(domainTrackingHosts.domainId, domainId))
			.limit(1);
		return row?.hostname ?? null;
	} catch (error) {
		if (isMissingTableError(error)) throw new TrackingHostsUnavailableError();
		throw error;
	}
}

export async function setDomainTrackingHost(env: CloudflareEnv, domainId: string, hostname: string | null): Promise<void> {
	const db = getDb(env);
	try {
		if (!hostname) {
			await db.delete(domainTrackingHosts).where(eq(domainTrackingHosts.domainId, domainId));
			return;
		}
		await db
			.insert(domainTrackingHosts)
			.values({ domainId, hostname })
			.onConflictDoUpdate({ target: domainTrackingHosts.domainId, set: { hostname } });
	} catch (error) {
		if (isMissingTableError(error)) throw new TrackingHostsUnavailableError();
		throw error;
	}
}

export class TrackingHostsUnavailableError extends Error {
	constructor() {
		super("Apply pending database migrations to set a read-receipt address");
		this.name = "TrackingHostsUnavailableError";
	}
}

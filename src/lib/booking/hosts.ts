import { and, eq, inArray } from "drizzle-orm";
import type { getDb } from "@/db";
import { users } from "@/db/schema";

type Db = ReturnType<typeof getDb>;

export function parseBookingHostIds(value: string, ownerId: string): string[] {
	try {
		const parsed: unknown = JSON.parse(value);
		if (Array.isArray(parsed) && parsed.length && parsed.every((id) => typeof id === "string" && id.length > 0) && new Set(parsed).size === parsed.length) return [ownerId, ...parsed.filter((id) => id !== ownerId)];
	} catch { /* Older booking events have only the owner. */ }
	return [ownerId];
}

export async function validBookingHostIds(db: Db, ownerId: string, requested: string[], canManageHosts: boolean): Promise<string[] | null> {
	const hostIds = [ownerId, ...requested.filter((id) => id !== ownerId)];
	if (hostIds.length > 20 || (!canManageHosts && hostIds.length > 1)) return null;
	const active = await db.select({ id: users.id }).from(users).where(and(inArray(users.id, hostIds), eq(users.disabled, false), eq(users.calendarEnabled, true)));
	return active.length === hostIds.length ? hostIds : null;
}

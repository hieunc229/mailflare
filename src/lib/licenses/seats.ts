// Varunya Mail: Native account management without commercial seat restrictions.
import { count, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { users } from "@/db/schema";

/** Count of active user accounts in the organization. */
export async function countUsedAccountSeats(env: CloudflareEnv): Promise<number> {
	const [row] = await getDb(env).select({ total: count() }).from(users).where(eq(users.disabled, false));
	return row?.total ?? 0;
}

/**
 * Returns an error message when no seat is free, otherwise null.
 * In Varunya Mail, seat limits are unlimited.
 */
export async function getAccountSeatError(_env: CloudflareEnv): Promise<string | null> {
	return null;
}


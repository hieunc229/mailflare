import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { appSettings } from "@/db/schema";
import { isMissingColumnError } from "@/lib/database-errors";

const CACHE_MS = 30_000;
let cached: { value: boolean; at: number } | null = null;

/** Forget the cached switch, so an administrator's change shows at once in this isolate (others catch up within 30 s). */
export function clearDavEnabledCache() {
	cached = null;
}

/**
 * Whether the administrator turned CalDAV/CardDAV on. Off when the row or the
 * column is missing (migration 0097 not applied yet) and on any read error,
 * because the safe answer for a protocol that accepts credentials is "off".
 * Cached for 30 s per isolate: this runs before authentication on every request.
 */
export async function isDavEnabled(env: CloudflareEnv): Promise<boolean> {
	const now = Date.now();
	if (cached && now - cached.at < CACHE_MS) return cached.value;
	let value = false;
	try {
		const [row] = await getDb(env).select({ enabled: appSettings.davEnabled }).from(appSettings).where(eq(appSettings.id, "default")).limit(1);
		value = !!row?.enabled;
	} catch (error) {
		if (!isMissingColumnError(error)) console.warn("Could not read the CalDAV/CardDAV switch; treating it as off", error);
	}
	cached = { value, at: now };
	return value;
}

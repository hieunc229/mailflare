import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { appSettings } from "@/db/schema";
import { isMissingColumnError } from "@/lib/database-errors";

const CACHE_MS = 30_000;
let cached: { value: boolean; at: number } | null = null;

/** Forget the cached switch so an administrator's change takes effect in this isolate immediately. */
export function clearImapEnabledCache() {
	cached = null;
}

/** Fail closed when the switch is absent or unreadable; cache per isolate for 30 seconds. */
export async function isImapEnabled(env: CloudflareEnv): Promise<boolean> {
	const now = Date.now();
	if (cached && now - cached.at < CACHE_MS) return cached.value;
	let value = false;
	try {
		const [row] = await getDb(env).select({ enabled: appSettings.imapEnabled }).from(appSettings).where(eq(appSettings.id, "default")).limit(1);
		value = !!row?.enabled;
	} catch (error) {
		if (!isMissingColumnError(error)) console.warn("Could not read the IMAP switch; treating it as off", error);
	}
	cached = { value, at: now };
	return value;
}

import { env } from "cloudflare:workers";
import { getNodeEnv } from "@/lib/runtime";
import { getD1Session, withD1Session } from "@/lib/d1-session-context";
import { withDatabase } from "@/db/with-database";
import { withStorage } from "@/lib/storage";

export function getEnv(): CloudflareEnv {
	const base = getNodeEnv() ?? (env as CloudflareEnv);
	const session = getD1Session();
	return withDatabase(withStorage(session ? withD1Session(base, session) : base));
}

export async function getEnvAsync(): Promise<CloudflareEnv> {
	return getEnv();
}

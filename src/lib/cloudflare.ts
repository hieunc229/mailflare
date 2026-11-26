import { env } from "cloudflare:workers";
import { getNodeEnv } from "@/lib/runtime";
import { getD1Session, withD1Session } from "@/lib/d1-session-context";
import { withDatabase } from "@/db/with-database";
import { withStorage } from "@/lib/storage";
import { getTenantEnv } from "@/lib/tenancy/context";

export function getEnv(): CloudflareEnv {
	// A multi-tenant deployment (worker.tenant.ts) carries the workspace's own bindings with the request.
	const base = getTenantEnv() ?? getNodeEnv() ?? (env as CloudflareEnv);
	const session = getD1Session();
	return withDatabase(withStorage(session ? withD1Session(base, session) : base));
}

export async function getEnvAsync(): Promise<CloudflareEnv> {
	return getEnv();
}

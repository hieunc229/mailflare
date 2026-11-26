import { AsyncLocalStorage } from "node:async_hooks";

/**
 * The env of the tenant serving the current request. `getEnv()` reads bindings from `cloudflare:workers`,
 * not from the env `worker.tenant.ts` receives, so a tenant's database, bucket and limits travel with the
 * request itself, the same way the D1 read session does (see d1-session-context.ts).
 */
const storage = new AsyncLocalStorage<CloudflareEnv>();

export function runWithTenantEnv<T>(env: CloudflareEnv, run: () => T): T {
	return storage.run(env, run);
}

export function getTenantEnv(): CloudflareEnv | undefined {
	return storage.getStore();
}

import { AsyncLocalStorage } from "node:async_hooks";

/**
 * The D1 session serving the current request. `getEnv()` reads application bindings from
 * `cloudflare:workers`, not from the env `worker.ts` receives, so the session has to travel
 * with the request itself: `worker.ts` runs the app handler inside `runWithD1Session` and
 * `getEnv()` swaps `DB` for it.
 */
const storage = new AsyncLocalStorage<D1DatabaseSession>();

export function runWithD1Session<T>(session: D1DatabaseSession | null | undefined, run: () => T): T {
	return session ? storage.run(session, run) : run();
}

export function getD1Session(): D1DatabaseSession | undefined {
	return storage.getStore();
}

/** `DB` becomes the request's session and `DB_PRIMARY` keeps the raw binding for authentication reads. */
export function withD1Session(env: CloudflareEnv, session: D1DatabaseSession): CloudflareEnv {
	return new Proxy(env, {
		get: (target, property) =>
			property === "DB" ? session : property === "DB_PRIMARY" ? target.DB : Reflect.get(target, property),
	});
}

import { getObjectStorageConfig, storageStartupProblem } from "@/lib/storage/b2-config";
import { openB2Bucket } from "@/lib/storage/b2-bucket";

const wrapped = new WeakMap<object, CloudflareEnv>();
const proxies = new WeakSet<object>();
const reported = new Set<string>();

/**
 * Returns env with BUCKET served by Backblaze B2 (B2_*) or AWS S3 (S3_*) when configured; otherwise env unchanged
 * (the R2 binding on Workers, the file bucket when self-hosted). Every caller reads `env.BUCKET`, so this one
 * place decides where objects live. Proxied rather than spread because Worker bindings are not enumerable.
 */
export function withStorage(env: CloudflareEnv): CloudflareEnv {
	if (proxies.has(env)) return env;
	const cached = wrapped.get(env);
	if (cached) return cached;
	const config = getObjectStorageConfig(env);
	if (!config) {
		// A mistyped S3_ENDPOINT must not pass unnoticed while mail goes to R2 or local files.
		const problem = storageStartupProblem(env);
		if (problem && !reported.has(problem)) { reported.add(problem); console.error(`Object storage: ${problem} Using the default storage instead.`); }
		return env;
	}
	const bucket = openB2Bucket(config);
	const proxy = new Proxy(env, { get: (target, property) => (property === "BUCKET" ? bucket : Reflect.get(target, property)) });
	wrapped.set(env, proxy);
	proxies.add(proxy);
	return proxy;
}

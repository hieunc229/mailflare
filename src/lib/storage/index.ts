import { getObjectStorageConfig, usesDatabaseStorage } from "@/lib/storage/b2-config";
import { openB2Bucket } from "@/lib/storage/b2-bucket";
import { openDatabaseBucket } from "@/lib/storage/db-bucket";

const wrapped = new WeakMap<object, CloudflareEnv>();
const proxies = new WeakSet<object>();

function storageBucketFor(env: CloudflareEnv): R2Bucket | null {
	// An explicit STORAGE_DRIVER=database wins over any other configured store.
	if (usesDatabaseStorage(env)) return openDatabaseBucket(env);
	const config = getObjectStorageConfig(env);
	if (config) return openB2Bucket(config);
	// No bucket bound at all (a Worker deployed without R2, for example) falls back to the
	// database rather than failing every object write.
	if (!env.BUCKET) return openDatabaseBucket(env);
	return null;
}

/**
 * Returns env with BUCKET served by Backblaze B2 (B2_*), AWS S3 (S3_*) or the database
 * (STORAGE_DRIVER=database, or automatically when no bucket is bound) when configured; otherwise
 * env unchanged (the R2 binding on Workers, the file bucket when self-hosted). Every caller reads
 * `env.BUCKET`, so this one place decides where objects live. Proxied rather than spread because
 * Worker bindings are not enumerable.
 */
export function withStorage(env: CloudflareEnv): CloudflareEnv {
	if (proxies.has(env)) return env;
	const cached = wrapped.get(env);
	if (cached) return cached;
	const bucket = storageBucketFor(env);
	if (!bucket) return env;
	const proxy = new Proxy(env, { get: (target, property) => (property === "BUCKET" ? bucket : Reflect.get(target, property)) });
	wrapped.set(env, proxy);
	proxies.add(proxy);
	return proxy;
}

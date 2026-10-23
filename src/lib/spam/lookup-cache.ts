/**
 * Caches results of external spam lookups (blocklists, RDAP) per isolate and in object storage. The Cache API
 * is not an option: it does nothing on workers.dev hostnames and does not exist in the self-hosted runtime.
 */
const memory = new Map<string, { expires: number; value: unknown }>();
const MAX_MEMORY_ENTRIES = 2000;
const STORAGE_PREFIX = "spam-cache/";

type CacheBucket = Pick<R2Bucket, "get" | "put">;

export async function cachedLookup<T>(
	bucket: CacheBucket | undefined,
	key: string,
	ttlSeconds: (value: T) => number,
	load: () => Promise<T>,
): Promise<T> {
	const now = Date.now();
	const cached = memory.get(key);
	if (cached && cached.expires > now) return cached.value as T;

	const storageKey = `${STORAGE_PREFIX}${key}.json`;
	if (bucket) {
		try {
			const object = await bucket.get(storageKey);
			const stored = object ? ((await object.json()) as { expires: number; value: T }) : null;
			if (stored && stored.expires > now) {
				remember(key, stored.expires, stored.value);
				return stored.value;
			}
		} catch {}
	}

	const value = await load();
	const expires = now + ttlSeconds(value) * 1000;
	remember(key, expires, value);
	if (bucket) {
		await bucket.put(storageKey, JSON.stringify({ expires, value }), { httpMetadata: { contentType: "application/json" } }).catch(() => {});
	}
	return value;
}

function remember(key: string, expires: number, value: unknown) {
	if (memory.size >= MAX_MEMORY_ENTRIES) memory.delete(memory.keys().next().value!);
	memory.set(key, { expires, value });
}

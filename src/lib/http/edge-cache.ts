/** The Workers cache, or null on Node (and anywhere `caches.default` is missing): callers then just compute. */
function edgeCache(): Cache | null {
	const cache = (globalThis as { caches?: { default?: Cache } }).caches?.default;
	return cache && typeof cache.match === "function" && typeof cache.put === "function" ? cache : null;
}

/**
 * A short-lived Workers cache entry for a public read that is expensive to compute and the same for everyone (`key` names it, so it must name
 * every input; it is only a cache key, never fetched). `compute` returns the JSON body. The cache is an optimisation: a miss, an error, or no
 * cache at all (Node) computes the answer, and a failure to store never fails the request. Only decisions that are re-checked live may use it.
 */
export async function cachedJson<T>(key: string, seconds: number, compute: () => Promise<T>): Promise<T> {
	const cache = edgeCache();
	if (!cache) return compute();
	const request = new Request(`https://edge-cache.invalid/${key}`);
	try {
		const hit = await cache.match(request);
		if (hit) return await hit.json() as T;
	} catch (error) {
		console.warn("Edge cache read failed", error);
	}
	const value = await compute();
	try {
		await cache.put(request, new Response(JSON.stringify(value), { headers: { "Content-Type": "application/json", "Cache-Control": `public, max-age=${seconds}` } }));
	} catch (error) {
		console.warn("Edge cache write failed", error);
	}
	return value;
}

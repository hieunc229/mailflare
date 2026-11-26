const KEY = "secrets/group-unsubscribe.key";
let cache = new WeakMap<object, Promise<string>>();

/** For tests: a new isolate starts with an empty cache. */
export function forgetUnsubscribeSecretCache(): void {
	cache = new WeakMap();
}

async function load(env: CloudflareEnv): Promise<string> {
	const existing = await env.BUCKET.get(KEY);
	if (existing) {
		const value = new TextDecoder().decode(await existing.arrayBuffer()).trim();
		if (value) return value;
	}
	const fresh = Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) => byte.toString(16).padStart(2, "0")).join("");
	await env.BUCKET.put(KEY, new TextEncoder().encode(fresh), { httpMetadata: { contentType: "text/plain" } });
	// Read back: if two isolates raced to create it, both settle on whichever write the bucket kept.
	const stored = await env.BUCKET.get(KEY);
	return stored ? new TextDecoder().decode(await stored.arrayBuffer()).trim() || fresh : fresh;
}

/**
 * The key that signs unsubscribe links: random, created on first use and kept in the bucket, so it does not
 * change when `CF_TOKEN`, `CF_API_KEY` or the webhook secret is rotated (links in mail already sent keep working)
 * and is not an API credential. Deleting the object revokes every link.
 */
export function getUnsubscribeSecret(env: CloudflareEnv): Promise<string> {
	const holder = env.BUCKET as unknown as object;
	let secret = cache.get(holder);
	if (!secret) {
		secret = load(env).catch((error) => {
			cache.delete(holder);
			throw error;
		});
		cache.set(holder, secret);
	}
	return secret;
}

const KEY = "secrets/group-unsubscribe.key";
let cache = new WeakMap<object, Promise<string>>();

/** For tests: a new isolate starts with an empty cache. */
export function forgetUnsubscribeSecretCache(): void {
	cache = new WeakMap();
}

/** How long a creator waits before it reads the key back: long enough for a racing creator's write to have landed. */
const SETTLE_MS = 300;

async function read(env: CloudflareEnv): Promise<string | null> {
	const stored = await env.BUCKET.get(KEY);
	return stored ? new TextDecoder().decode(await stored.arrayBuffer()).trim() || null : null;
}

async function load(env: CloudflareEnv): Promise<string> {
	const existing = await read(env);
	if (existing) return existing;
	const fresh = Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) => byte.toString(16).padStart(2, "0")).join("");
	// `onlyIf` makes the write refuse to replace an existing key where the bucket supports it (R2); elsewhere the last writer wins.
	// A failed write throws: a key that was never stored would sign links nobody can verify later.
	await env.BUCKET.put(KEY, new TextEncoder().encode(fresh), { httpMetadata: { contentType: "text/plain" }, onlyIf: { etagDoesNotMatch: "*" } } as R2PutOptions);
	// Whatever is stored once the writers have settled is the key; nothing is signed with a value that might be overwritten.
	await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
	const stored = await read(env);
	if (!stored) throw new Error("The unsubscribe key could not be stored");
	return stored;
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

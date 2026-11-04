const OBJECT_KEY = "config/signing-secret";

function hex(bytes: Uint8Array): string {
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * A secret only this installation knows, for signing short-lived tokens. Deployment secrets are
 * preferred; otherwise one is generated once and kept in the bucket, so no setup is required.
 */
export async function getServerSecret(env: CloudflareEnv): Promise<string> {
	const configured = env.CF_TOKEN || env.CF_API_KEY || env.INBOUND_WEBHOOK_SECRET;
	if (configured) return configured;
	const existing = await env.BUCKET.get(OBJECT_KEY);
	if (existing) return (await existing.text()).trim();
	const generated = hex(crypto.getRandomValues(new Uint8Array(32)));
	await env.BUCKET.put(OBJECT_KEY, generated);
	// Two first requests can race; whichever object won is the secret both must use.
	const stored = await env.BUCKET.get(OBJECT_KEY);
	return stored ? (await stored.text()).trim() : generated;
}

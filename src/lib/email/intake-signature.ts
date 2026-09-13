function hex(buffer: ArrayBuffer): string {
	return Array.from(new Uint8Array(buffer), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function hmac(secret: string, raw: ArrayBuffer, from: string, to: string): Promise<string> {
	const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
	const prefix = new TextEncoder().encode(`${from}\n${to}\n`);
	const data = new Uint8Array(prefix.byteLength + raw.byteLength);
	data.set(prefix, 0);
	data.set(new Uint8Array(raw), prefix.byteLength);
	return hex(await crypto.subtle.sign("HMAC", key, data));
}

/** HMAC-SHA256 over `from\nto\n` + raw body, hex encoded. Shared with the relay Worker. */
export async function signInbound(secret: string, raw: ArrayBuffer, from: string, to: string): Promise<string> {
	return hmac(secret, raw, from, to);
}

export async function verifyInboundSignature(secret: string, signature: string, raw: ArrayBuffer, from: string, to: string): Promise<boolean> {
	const expected = await hmac(secret, raw, from, to);
	if (expected.length !== signature.length) return false;
	let diff = 0;
	for (let index = 0; index < expected.length; index += 1) diff |= expected.charCodeAt(index) ^ signature.charCodeAt(index);
	return diff === 0;
}

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

export const INBOUND_SIGNATURE_MAX_AGE_SECONDS = 300;

async function hmacV2(secret: string, raw: ArrayBuffer, from: string, to: string, headers: string, timestamp: string): Promise<string> {
	const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
	const prefix = new TextEncoder().encode(`v2\n${timestamp}\n${from}\n${to}\n${headers}\n`);
	const data = new Uint8Array(prefix.byteLength + raw.byteLength);
	data.set(prefix, 0);
	data.set(new Uint8Array(raw), prefix.byteLength);
	return hex(await crypto.subtle.sign("HMAC", key, data));
}

/**
 * Version 2 also covers the header map and a Unix timestamp (seconds), so neither can be altered
 * in transit and a captured request stops verifying after a few minutes.
 */
export async function signInboundV2(secret: string, raw: ArrayBuffer, from: string, to: string, headers: string, timestamp: string): Promise<string> {
	return hmacV2(secret, raw, from, to, headers, timestamp);
}

export async function verifyInboundSignatureV2(
	secret: string,
	signature: string,
	raw: ArrayBuffer,
	from: string,
	to: string,
	headers: string,
	timestamp: string,
	nowSeconds = Math.floor(Date.now() / 1000),
): Promise<boolean> {
	const sentAt = Number(timestamp);
	if (!Number.isFinite(sentAt) || Math.abs(nowSeconds - sentAt) > INBOUND_SIGNATURE_MAX_AGE_SECONDS) return false;
	const expected = await hmacV2(secret, raw, from, to, headers, timestamp);
	if (expected.length !== signature.length) return false;
	let diff = 0;
	for (let index = 0; index < expected.length; index += 1) diff |= expected.charCodeAt(index) ^ signature.charCodeAt(index);
	return diff === 0;
}

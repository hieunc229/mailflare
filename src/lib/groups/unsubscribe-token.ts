const encoder = new TextEncoder();

export type UnsubscribeClaim = { groupId: string; memberId: string };

function toBase64Url(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(value: string): Uint8Array<ArrayBuffer> | null {
	if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
	try {
		const binary = atob(value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "="));
		return Uint8Array.from(binary, (char) => char.charCodeAt(0));
	} catch {
		return null;
	}
}

async function mac(secret: string, payload: Uint8Array<ArrayBuffer>): Promise<Uint8Array> {
	// Own key domain: the forwarded-mail marker is keyed from the same server secret and must never validate here.
	const key = await crypto.subtle.importKey("raw", encoder.encode(`mailflare-group-unsub\n${secret}`), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
	return new Uint8Array(await crypto.subtle.sign("HMAC", key, payload));
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let index = 0; index < a.length; index += 1) diff |= a[index] ^ b[index];
	return diff === 0;
}

/**
 * `base64url(groupId \n memberId) . base64url(HMAC-SHA256)`. The MAC covers both, so a token removes exactly
 * one member row of exactly one group and cannot be re-aimed. It carries no address: the row says whose it is.
 */
export async function signUnsubscribeToken(secret: string, claim: UnsubscribeClaim): Promise<string> {
	const payload = encoder.encode(`${claim.groupId}\n${claim.memberId}`);
	return `${toBase64Url(payload)}.${toBase64Url(await mac(secret, payload))}`;
}

/** The claim a token proves, or null for anything malformed or not signed with this secret. */
export async function verifyUnsubscribeToken(secret: string, token: string): Promise<UnsubscribeClaim | null> {
	const parts = token.split(".");
	if (parts.length !== 2 || token.length > 2048) return null;
	const payload = fromBase64Url(parts[0]);
	const given = fromBase64Url(parts[1]);
	if (!payload || !given || !sameBytes(await mac(secret, payload), given)) return null;
	const fields = new TextDecoder().decode(payload).split("\n");
	if (fields.length !== 2 || fields.some((field) => !field)) return null;
	return { groupId: fields[0], memberId: fields[1] };
}

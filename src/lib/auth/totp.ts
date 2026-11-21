/**
 * RFC 6238 TOTP over Web Crypto, with no dependency. HMAC-SHA1, 30-second
 * steps, six digits: the profile every authenticator app implements.
 */
const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const STEP_SECONDS = 30;
const DIGITS = 6;

export function base32Encode(bytes: Uint8Array): string {
	let bits = 0;
	let value = 0;
	let output = "";
	for (const byte of bytes) {
		value = (value << 8) | byte;
		bits += 8;
		while (bits >= 5) {
			output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
			bits -= 5;
		}
	}
	if (bits > 0) output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
	return output;
}

export function base32Decode(input: string): Uint8Array<ArrayBuffer> {
	const clean = input.toUpperCase().replace(/[^A-Z2-7]/g, "");
	const bytes: number[] = [];
	let bits = 0;
	let value = 0;
	for (const char of clean) {
		value = (value << 5) | BASE32_ALPHABET.indexOf(char);
		bits += 5;
		if (bits >= 8) {
			bytes.push((value >>> (bits - 8)) & 255);
			bits -= 8;
		}
	}
	const out = new Uint8Array(new ArrayBuffer(bytes.length));
	out.set(bytes);
	return out;
}

/** 160-bit secret, the size RFC 4226 recommends for HMAC-SHA1. */
export function generateTotpSecret(): string {
	const bytes = new Uint8Array(20);
	crypto.getRandomValues(bytes);
	return base32Encode(bytes);
}

export async function hotp(secret: string, counter: number): Promise<string> {
	const key = await crypto.subtle.importKey("raw", base32Decode(secret), { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
	const message = new Uint8Array(8);
	// Big-endian 64-bit counter; the high word stays zero for any sane clock.
	let remaining = counter;
	for (let index = 7; index >= 0; index -= 1) {
		message[index] = remaining & 255;
		remaining = Math.floor(remaining / 256);
	}
	const digest = new Uint8Array(await crypto.subtle.sign("HMAC", key, message));
	const offset = digest[digest.length - 1] & 15;
	const binary =
		((digest[offset] & 127) << 24) | ((digest[offset + 1] & 255) << 16) | ((digest[offset + 2] & 255) << 8) | (digest[offset + 3] & 255);
	return String(binary % 10 ** DIGITS).padStart(DIGITS, "0");
}

export function totpCounter(at: number = Date.now()): number {
	return Math.floor(at / 1000 / STEP_SECONDS);
}

export async function totp(secret: string, at: number = Date.now()): Promise<string> {
	return hotp(secret, totpCounter(at));
}

/**
 * The step a code belongs to, or null. Accepts the current step and one on
 * either side, so a phone whose clock is a few seconds off still works.
 * Comparison is constant-time. A match alone is not a login: callers must
 * record the step (`claimTotpStep`) so the same code cannot be used twice.
 */
export async function matchTotpStep(secret: string, code: string, at: number = Date.now()): Promise<number | null> {
	const candidate = code.replace(/\s+/g, "");
	if (!/^\d{6}$/.test(candidate)) return null;
	const counter = totpCounter(at);
	let matched: number | null = null;
	for (const delta of [-1, 0, 1]) {
		const expected = await hotp(secret, counter + delta);
		if (timingSafeEqual(expected, candidate)) matched = counter + delta;
	}
	return matched;
}

export function timingSafeEqual(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let index = 0; index < a.length; index += 1) diff |= a.charCodeAt(index) ^ b.charCodeAt(index);
	return diff === 0;
}

/** The URI authenticator apps read from a QR code (Google Authenticator key format). */
export function buildOtpauthUrl(input: { issuer: string; account: string; secret: string }): string {
	const label = `${encodeURIComponent(input.issuer)}:${encodeURIComponent(input.account)}`;
	const params = new URLSearchParams({
		secret: input.secret,
		issuer: input.issuer,
		algorithm: "SHA1",
		digits: String(DIGITS),
		period: String(STEP_SECONDS),
	});
	return `otpauth://totp/${label}?${params.toString()}`;
}

/** Carries the first-run setup code on every setup request made before the first admin exists. */
export const SETUP_CODE_HEADER = "X-Mailflare-Setup-Code";

// Crockford base32: no I, L, O or U, so a code copied from a log is hard to misread.
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** An 80-bit code derived from a secret, as four groups of four characters. */
export async function deriveSetupCode(secret: string): Promise<string> {
	const encoder = new TextEncoder();
	const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
	const digest = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode("mailflare:first-run-setup")));
	let code = "";
	let buffer = 0;
	let bits = 0;
	for (const byte of digest.subarray(0, 10)) {
		buffer = ((buffer << 8) | byte) & 0xfff;
		bits += 8;
		while (bits >= 5) {
			bits -= 5;
			code += ALPHABET[(buffer >> bits) & 31];
		}
	}
	return code.match(/.{4}/g)!.join("-");
}

/** Ignores case, spaces and dashes, and reads the letters Crockford base32 leaves out as the digits they resemble. */
export function normalizeSetupCode(value: string): string {
	return value.replace(/[\s-]/g, "").toUpperCase().replace(/O/g, "0").replace(/[IL]/g, "1");
}

/**
 * The code that unlocks first-run setup. SETUP_TOKEN wins when the deployer set one. Otherwise the code is derived
 * from a secret only the deployer holds: the Node runtime's per-process secret, or the Cloudflare credentials on
 * Workers, which every isolate shares, so all of them agree on the code without storing it anywhere.
 */
export async function getSetupCode(env: CloudflareEnv): Promise<{ code: string; derived: boolean } | null> {
	const configured = env.SETUP_TOKEN?.trim();
	if (configured) return { code: configured, derived: false };
	const secret = env.SETUP_CODE_SECRET || env.CF_TOKEN?.trim() || env.CF_API_KEY?.trim();
	return secret ? { code: await deriveSetupCode(secret), derived: true } : null;
}

export function logSetupCode(code: string): void {
	console.log(`Mailflare first-run setup code: ${code} (enter it on /setup to create the first admin account)`);
}

import bcrypt from "bcryptjs";
import { customAlphabet } from "nanoid";
import { newId } from "@/lib/ids";

const KEY_PREFIX = "ep_";
const encoder = new TextEncoder();

export type IssuedApiKey = { fullKey: string; prefix: string; hash: string; sha256: string };

/** Lowercase hex SHA-256 of an API key or app password. */
export async function hashApiKey(fullKey: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", encoder.encode(fullKey));
	let hex = "";
	for (const byte of new Uint8Array(digest)) hex += byte.toString(16).padStart(2, "0");
	return hex;
}

/**
 * Constant-time compare for equal-length hashes. A length mismatch fails
 * closed; the hashes this stores are fixed width.
 */
export function timingSafeEqualText(left: string, right: string): boolean {
	const a = encoder.encode(left);
	const b = encoder.encode(right);
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let index = 0; index < a.length; index += 1) diff |= a[index]! ^ b[index]!;
	return diff === 0;
}

async function issueApiKey(fullKey: string, prefix: string): Promise<IssuedApiKey> {
	const sha256 = await hashApiKey(fullKey);
	// These secrets are high-entropy. SHA-256 is the verifier, and `key_hash`
	// repeats it so the NOT NULL column stays a hash of the secret. bcrypt here
	// would blow the Workers free-tier CPU limit on the request that creates the key.
	return { fullKey, prefix, hash: sha256, sha256 };
}

export async function generateApiKey(): Promise<IssuedApiKey> {
	const fullKey = `${KEY_PREFIX}${newId()}`;
	return issueApiKey(fullKey, fullKey.slice(0, 12));
}

const APP_PASSWORD_LENGTH = 16;
const APP_PASSWORD_PREFIX_LENGTH = 6;
const generateAppPasswordSecret = customAlphabet("0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ", APP_PASSWORD_LENGTH);

/** Stored lookup prefix for a presented key: short app passwords keep fewer plaintext characters. */
export function apiKeyLookupPrefix(key: string): string {
	return key.slice(0, key.length <= APP_PASSWORD_LENGTH ? APP_PASSWORD_PREFIX_LENGTH : 12);
}

/** 16-character password for mail apps. Older, longer `ep_` keys keep working. */
export async function generateAppPassword(): Promise<IssuedApiKey> {
	const fullKey = generateAppPasswordSecret();
	return issueApiKey(fullKey, apiKeyLookupPrefix(fullKey));
}

/**
 * bcrypt check for API keys issued before `key_sha256` existed. Human passwords
 * go through `verifyPassword` and are not handled here. Non-bcrypt values return
 * false without calling into bcrypt.
 */
export function verifyApiKey(fullKey: string, hash: string): boolean {
	if (!hash.startsWith("$2")) return false;
	return bcrypt.compareSync(fullKey, hash);
}

export function parseScopes(scopesJson: string): string[] {
	try {
		const parsed = JSON.parse(scopesJson) as unknown;
		return Array.isArray(parsed) ? parsed.filter((s): s is string => typeof s === "string") : [];
	} catch {
		return [];
	}
}

export function scopesToJson(scopes: string[]): string {
	return JSON.stringify(scopes);
}

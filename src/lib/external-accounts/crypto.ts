/**
 * Encryption for stored external-account credentials (IMAP/POP3 passwords), on Web Crypto so it runs on
 * Workers and on the self-hosted Node runtime.
 *
 * The operator supplies one long random secret (`MAILFLARE_ENCRYPTION_KEY`, e.g. `openssl rand -base64 32`).
 * HKDF-SHA256 turns it into an AES-256-GCM key for this purpose only (info `mailflare-external-accounts-v1`),
 * and every write gets a fresh 96-bit nonce. The stored value is base64 of `nonce || ciphertext || tag`.
 *
 * Failing closed is the whole point: with no usable key, encrypt and decrypt both throw
 * `ExternalAccountCryptoError` instead of falling back to plaintext. Neither the secret, the key nor the
 * ciphertext is ever put in an error message or a log line.
 */
import { fromBase64, toBase64 } from "@/lib/push/native-crypto";
import { hasUnpairedSurrogate, UNPAIRED_SURROGATE_MESSAGE } from "./text";

export const EXTERNAL_ACCOUNT_HKDF_INFO = "mailflare-external-accounts-v1";
/** The operator secret this module reads. Shared with nothing else, so a rotation only touches this feature. */
export const ENCRYPTION_KEY_ENV = "MAILFLARE_ENCRYPTION_KEY";
/** `openssl rand -base64 32` is 44 characters; anything shorter is a placeholder, not a key. */
const MIN_KEY_LENGTH = 32;
/**
 * Secrets that are known placeholders before they are random. Length is all that is checked otherwise: a long
 * repeated string is accepted (and documented as accepted) rather than guessed at by an entropy heuristic.
 */
const PLACEHOLDER_KEY_PREFIXES = ["change-me", "changeme", "replace-me", "your-key", "your-encryption-key", "placeholder"];
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
/** The longest password a route accepts (1024 characters, up to 4 UTF-8 bytes each). */
const MAX_SECRET_BYTES = 1024 * 4;
/** Enough for one rotation in flight, without keeping stale secrets in memory forever. */
const MAX_CACHED_KEYS = 4;

export type ExternalAccountCryptoErrorCode =
	| "encryption_key_missing"
	| "encryption_key_invalid"
	| "secret_empty"
	| "secret_not_encodable"
	| "secret_decrypt_failed";

export class ExternalAccountCryptoError extends Error {
	constructor(
		readonly code: ExternalAccountCryptoErrorCode,
		message: string,
	) {
		super(message);
		this.name = "ExternalAccountCryptoError";
	}
}

export function isExternalAccountCryptoError(error: unknown): error is ExternalAccountCryptoError {
	return error instanceof ExternalAccountCryptoError;
}

type EncryptionEnv = Pick<CloudflareEnv, "MAILFLARE_ENCRYPTION_KEY">;

const derivedKeys = new Map<string, Promise<CryptoKey>>();

function buffer(bytes: Uint8Array): ArrayBuffer {
	const out = new ArrayBuffer(bytes.byteLength);
	new Uint8Array(out).set(bytes);
	return out;
}

/** Trimmed operator secret, or a typed error the route can turn into a status. */
function encryptionSecret(env: EncryptionEnv): string {
	const secret = env.MAILFLARE_ENCRYPTION_KEY?.trim();
	if (!secret) {
		throw new ExternalAccountCryptoError(
			"encryption_key_missing",
			`Stored external account passwords need ${ENCRYPTION_KEY_ENV}; generate one with "openssl rand -base64 32".`,
		);
	}
	if (secret.length < MIN_KEY_LENGTH) {
		throw new ExternalAccountCryptoError(
			"encryption_key_invalid",
			`${ENCRYPTION_KEY_ENV} is too short; generate one with "openssl rand -base64 32".`,
		);
	}
	const lowered = secret.toLowerCase();
	if (PLACEHOLDER_KEY_PREFIXES.some((prefix) => lowered.startsWith(prefix))) {
		throw new ExternalAccountCryptoError(
			"encryption_key_invalid",
			`${ENCRYPTION_KEY_ENV} is still a placeholder; generate one with "openssl rand -base64 32".`,
		);
	}
	return secret;
}

/** HKDF-SHA256 over the operator secret, cached per secret so a poll loop derives the key once. */
function encryptionKey(secret: string): Promise<CryptoKey> {
	const cached = derivedKeys.get(secret);
	if (cached) return cached;
	const derived = (async () => {
		const material = await crypto.subtle.importKey("raw", buffer(new TextEncoder().encode(secret)), "HKDF", false, ["deriveKey"]);
		return crypto.subtle.deriveKey(
			{ name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: new TextEncoder().encode(EXTERNAL_ACCOUNT_HKDF_INFO) },
			material,
			{ name: "AES-GCM", length: 256 },
			// Extractable is not needed: the key never leaves Web Crypto.
			false,
			["encrypt", "decrypt"],
		);
	})();
	// A failed derivation must not stick in the cache, or a fixed env would keep failing.
	derived.catch(() => derivedKeys.delete(secret));
	derivedKeys.set(secret, derived);
	while (derivedKeys.size > MAX_CACHED_KEYS) {
		const oldest = derivedKeys.keys().next();
		if (oldest.done) break;
		derivedKeys.delete(oldest.value);
	}
	return derived;
}

/** Whether the install can store credentials at all; routes use it to answer before doing any work. */
export function isEncryptionConfigured(env: EncryptionEnv): boolean {
	try {
		encryptionSecret(env);
		return true;
	} catch {
		return false;
	}
}

/**
 * Encrypts a credential for storage. The result is the only form a password may take in the database,
 * a backup or a queue message: base64(nonce || ciphertext || tag).
 *
 * Empty input is refused here too, not only by the route validator: sealing an empty string would produce a
 * payload the reader then rejects for being too short.
 */
export async function encryptSecret(env: EncryptionEnv, plaintext: string): Promise<string> {
	if (plaintext.length === 0) {
		throw new ExternalAccountCryptoError("secret_empty", "A stored password cannot be empty.");
	}
	if (hasUnpairedSurrogate(plaintext)) {
		// UTF-8 would replace the lone surrogate with U+FFFD, so the value could never read back as it was.
		throw new ExternalAccountCryptoError("secret_not_encodable", UNPAIRED_SURROGATE_MESSAGE);
	}
	const key = await encryptionKey(encryptionSecret(env));
	const nonce = crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
	// The sealed output already ends with the 16-byte GCM tag.
	const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: buffer(nonce) }, key, buffer(new TextEncoder().encode(plaintext))));
	const payload = new Uint8Array(nonce.byteLength + sealed.byteLength);
	payload.set(nonce);
	payload.set(sealed, nonce.byteLength);
	return toBase64(payload);
}

/**
 * Whether a stored value looks like `encryptSecret` output: standard base64 of a 96-bit nonce, ciphertext
 * and its 16-byte tag, within the bounds a stored password can reach. Format only — it never decrypts, so it
 * cannot tell whether the key that wrote it is the key this install holds. The backup restore uses it to
 * refuse plaintext or truncated envelopes while still accepting a backup made under another key.
 */
export function isSealedSecretFormat(value: unknown): value is string {
	if (typeof value !== "string" || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return false;
	let bytes: Uint8Array;
	try {
		bytes = fromBase64(value);
	} catch {
		return false;
	}
	// At least one byte of ciphertext, and no more than the longest accepted password could produce.
	return bytes.byteLength > NONCE_BYTES + TAG_BYTES && bytes.byteLength <= NONCE_BYTES + TAG_BYTES + MAX_SECRET_BYTES;
}

/**
 * Reverses `encryptSecret`. A wrong key, a rotated key or a tampered payload all fail the GCM tag check and
 * surface as `secret_decrypt_failed`; nothing about the payload is echoed back.
 */
export async function decryptSecret(env: EncryptionEnv, payload: string): Promise<string> {
	const key = await encryptionKey(encryptionSecret(env));
	let bytes: Uint8Array;
	try {
		bytes = fromBase64(payload);
	} catch {
		throw new ExternalAccountCryptoError("secret_decrypt_failed", "The stored password could not be read; set it again.");
	}
	if (bytes.byteLength <= NONCE_BYTES + TAG_BYTES) {
		throw new ExternalAccountCryptoError("secret_decrypt_failed", "The stored password could not be read; set it again.");
	}
	const nonce = bytes.subarray(0, NONCE_BYTES);
	const sealed = bytes.subarray(NONCE_BYTES);
	let plaintext: ArrayBuffer;
	try {
		plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv: buffer(nonce) }, key, buffer(sealed));
	} catch {
		// Wrong key, rotated key or tampered payload. The cause is deliberately not attached: it can carry
		// operation details but nothing useful, and the caller must not start logging ciphertext.
		throw new ExternalAccountCryptoError("secret_decrypt_failed", "The stored password could not be read; set it again.");
	}
	try {
		// ignoreBOM keeps a leading U+FEFF, which a plain TextDecoder would silently drop; fatal refuses bytes
		// that are not UTF-8 instead of replacing them with U+FFFD. Both are needed for a lossless round trip.
		return new TextDecoder("utf-8", { ignoreBOM: true, fatal: true }).decode(plaintext);
	} catch {
		throw new ExternalAccountCryptoError("secret_decrypt_failed", "The stored password could not be read; set it again.");
	}
}

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { loadFixture } from "./helpers/fixtures.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const fixture = await loadFixture({ name: "external-accounts-crypto", entryPoint: "src/lib/external-accounts/crypto.ts", mocks: {} });
const { encryptSecret, decryptSecret, isEncryptionConfigured, isExternalAccountCryptoError, ENCRYPTION_KEY_ENV, EXTERNAL_ACCOUNT_HKDF_INFO } =
	await fixture.import();
after(() => fixture.dispose());

// `openssl rand -base64 32` output shape: 44 characters of base64.
const key = (seed) => Buffer.from(`${seed}`.padEnd(32, "-")).toString("base64").padEnd(44, "=").slice(0, 44);
const env = (value) => ({ MAILFLARE_ENCRYPTION_KEY: value });
const PASSWORD = "hunter2-Ünicode-p@ss";

/** The stored form only: base64, no punctuation from the plaintext, and never the plaintext itself. */
const payloadBytes = (payload) => Buffer.from(payload, "base64");

test("a stored password round-trips and never appears in the ciphertext", async () => {
	const stored = await encryptSecret(env(key("one")), PASSWORD);
	assert.match(stored, /^[A-Za-z0-9+/]+={0,2}$/);
	assert.ok(!stored.includes(PASSWORD));
	assert.ok(!stored.includes("hunter2"));
	// 12-byte nonce, the ciphertext, and the 16-byte GCM tag.
	assert.ok(payloadBytes(stored).length >= 12 + 16 + Buffer.byteLength(PASSWORD));
	assert.equal(await decryptSecret(env(key("one")), stored), PASSWORD);
});

test("every write uses a fresh nonce, so the same password stores differently", async () => {
	const first = await encryptSecret(env(key("one")), PASSWORD);
	const second = await encryptSecret(env(key("one")), PASSWORD);
	assert.notEqual(first, second);
	assert.notDeepEqual(payloadBytes(first).subarray(0, 12), payloadBytes(second).subarray(0, 12));
	assert.equal(await decryptSecret(env(key("one")), second), PASSWORD);
});

test("a different key cannot read the stored password", async () => {
	const stored = await encryptSecret(env(key("one")), PASSWORD);
	await assert.rejects(decryptSecret(env(key("two")), stored), (error) => {
		assert.ok(isExternalAccountCryptoError(error));
		assert.equal(error.code, "secret_decrypt_failed");
		// The failure message must not carry the secret, the ciphertext or the plaintext.
		assert.ok(!error.message.includes(stored));
		assert.ok(!error.message.includes(key("one")));
		assert.ok(!error.message.includes(PASSWORD));
		return true;
	});
});

test("a tampered payload fails the tag check instead of decrypting", async () => {
	const stored = await encryptSecret(env(key("one")), PASSWORD);
	const bytes = payloadBytes(stored);
	bytes[bytes.length - 1] ^= 0xff;
	await assert.rejects(decryptSecret(env(key("one")), bytes.toString("base64")), /could not be read/);
	await assert.rejects(decryptSecret(env(key("one")), "not base64 at all!"), /could not be read/);
	await assert.rejects(decryptSecret(env(key("one")), Buffer.alloc(20).toString("base64")), /could not be read/);
});

test("a missing key is a typed error, never a plaintext fallback", async () => {
	const missing = { MAILFLARE_ENCRYPTION_KEY: undefined };
	assert.equal(isEncryptionConfigured(missing), false);
	await assert.rejects(encryptSecret(missing, PASSWORD), (error) => {
		assert.ok(isExternalAccountCryptoError(error));
		assert.equal(error.code, "encryption_key_missing");
		assert.ok(error.message.includes(ENCRYPTION_KEY_ENV));
		assert.ok(error.message.includes("openssl rand -base64 32"));
		assert.ok(!error.message.includes(PASSWORD));
		return true;
	});
	assert.equal(isEncryptionConfigured({}), false);
	assert.equal(isEncryptionConfigured({ MAILFLARE_ENCRYPTION_KEY: "   " }), false);
});

test("a placeholder key is refused rather than stretched into a key", async () => {
	await assert.rejects(encryptSecret(env("change-me"), PASSWORD), (error) => {
		assert.equal(error.code, "encryption_key_invalid");
		return true;
	});
	assert.equal(isEncryptionConfigured(env("change-me")), false);
	const stored = await encryptSecret(env(key("one")), PASSWORD);
	await assert.rejects(decryptSecret(env("change-me"), stored), /too short/);
});

test("the derived key is purpose-scoped by HKDF info", () => {
	assert.equal(EXTERNAL_ACCOUNT_HKDF_INFO, "mailflare-external-accounts-v1");
	assert.equal(ENCRYPTION_KEY_ENV, "MAILFLARE_ENCRYPTION_KEY");
});

test("no dialect migration is needed for the sync state F37 and F38 will write", () => {
	const files = {
		sqlite: join(root, "drizzle/migrations/0111_external_accounts.sql"),
		postgres: join(root, "drizzle/migrations-pg/0035_external_accounts.sql"),
		mysql: join(root, "drizzle/migrations-mysql/0035_external_accounts.sql"),
	};
	for (const [dialect, file] of Object.entries(files)) {
		const sql = readFileSync(file, "utf8");
		for (const column of ["last_synced_at", "last_error", "sync_cursor", "password_encrypted", "tls_mode"]) {
			assert.ok(sql.includes(column), `${dialect} migration lacks ${column}`);
		}
		assert.ok(sql.includes("external_accounts_mailbox_host_user_idx"), `${dialect} lacks the duplicate guard`);
		assert.ok(sql.includes("external_accounts_poll_idx"), `${dialect} lacks the poller scan index`);
	}
	// The three history directories stay in step: no dialect may skip the table.
	for (const directory of ["drizzle/migrations", "drizzle/migrations-pg", "drizzle/migrations-mysql"]) {
		const names = readdirSync(join(root, directory)).filter((name) => name.endsWith("_external_accounts.sql"));
		assert.equal(names.length, 1, `${directory} has ${names.length} external_accounts migrations`);
	}
});

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { loadFixture } from "./helpers/fixtures.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const fixture = await loadFixture({ name: "external-accounts-crypto", entryPoint: "src/lib/external-accounts/crypto.ts", mocks: {} });
const { encryptSecret, decryptSecret, isEncryptionConfigured, isExternalAccountCryptoError, isSealedSecretFormat, ENCRYPTION_KEY_ENV, EXTERNAL_ACCOUNT_HKDF_INFO } =
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

test("a leading BOM survives the round trip and a lone surrogate is refused, not mangled", async () => {
	// A plain TextDecoder drops a leading U+FEFF, which would silently change an accepted password.
	const withBom = "\uFEFF" + PASSWORD;
	const stored = await encryptSecret(env(key("one")), withBom);
	assert.equal(await decryptSecret(env(key("one")), stored), withBom);
	assert.equal((await decryptSecret(env(key("one")), stored)).length, withBom.length);

	// An unpaired surrogate cannot be encoded as UTF-8 (it would become U+FFFD), so it is refused up front.
	for (const value of ["\uD800" + PASSWORD, PASSWORD + "\uDC00", "\uD83D"]) {
		await assert.rejects(encryptSecret(env(key("one")), value), (error) => {
			assert.equal(error.code, "secret_not_encodable");
			assert.match(error.message, /invalid Unicode/);
			return true;
		});
	}
	// A well-formed surrogate pair (an emoji) is fine and round-trips.
	const emoji = "p\u00e4ss\u{1F512}-word";
	assert.equal(await decryptSecret(env(key("one")), await encryptSecret(env(key("one")), emoji)), emoji);
});

test("an empty secret is refused by the helper, not sealed and rejected by the reader", async () => {
	await assert.rejects(encryptSecret(env(key("one")), ""), (error) => {
		assert.equal(error.code, "secret_empty");
		return true;
	});
});

test("the envelope format check accepts real output and refuses plaintext", async () => {
	const stored = await encryptSecret(env(key("one")), PASSWORD);
	assert.equal(isSealedSecretFormat(stored), true);
	// Truncation of the tag keeps the shape (only decrypting notices), so the format check looks at shape alone.
	for (const value of [PASSWORD, "", "not base64 at all!", Buffer.alloc(20).toString("base64"), `${stored}AAAA`]) {
		assert.equal(isSealedSecretFormat(value), false, value);
	}
	assert.equal(isSealedSecretFormat(undefined), false);
	assert.equal(isSealedSecretFormat(42), false);
	// Format only: an envelope sealed under another key is still a well-formed envelope, which is what lets a
	// wrong-key backup restore.
	assert.equal(isSealedSecretFormat(await encryptSecret(env(key("two")), PASSWORD)), true);
});

test("a placeholder key is refused even when it is long enough", async () => {
	for (const placeholder of ["change-me-before-use-".repeat(2), "CHANGE-ME-" + "x".repeat(40), "replace-me-" + "y".repeat(40), "placeholder-" + "z".repeat(40)]) {
		await assert.rejects(encryptSecret(env(placeholder), PASSWORD), (error) => {
			assert.equal(error.code, "encryption_key_invalid");
			assert.ok(!error.message.includes(placeholder));
			return true;
		});
	}
	// Anything else of sufficient length is used verbatim, whatever its shape.
	for (const accepted of [key("one"), "a".repeat(64), "k#".repeat(16)]) {
		assert.equal(await decryptSecret(env(` ${accepted}\n`), await encryptSecret(env(accepted), PASSWORD)), PASSWORD);
	}
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

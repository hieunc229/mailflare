import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

/**
 * The identity comparison a restore uses for `external_accounts` rows. Only `utf8mb4_bin` can be mirrored from
 * JavaScript; every other MySQL collation is compared exactly, so a valid backup is never refused (round-5
 * regression: `utf8mb4_tr_0900_ai_ci` keeps `I` and `i` distinct, and an untouched export was refused as a
 * duplicate).
 */
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const directory = mkdtempSync(join(root, "node_modules", "backup-identity-test-"));
after(() => rmSync(directory, { recursive: true, force: true }));

await build({
	stdin: {
		contents: `export { identityComparator, externalAccountCollations } from "./src/lib/backups/identity.ts";`,
		resolveDir: root,
		sourcefile: "backup-identity-entry.ts",
	},
	outfile: join(directory, "entry.mjs"),
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node24",
	tsconfig: join(root, "tsconfig.json"),
	packages: "external",
	logLevel: "silent",
});
const { identityComparator, externalAccountCollations } = await import(pathToFileURL(join(directory, "entry.mjs")).href);

const columns = (collation, { id = collation, mailbox = collation, host = collation, username = collation, padsSpaces = false } = {}) => ({
	id: { collation: id, padsSpaces },
	mailbox_id: { collation: mailbox, padsSpaces },
	host: { collation: host, padsSpaces },
	username: { collation: username, padsSpaces },
});

test("SQLite, PostgreSQL and D1 compare the identity exactly", () => {
	for (const dialect of ["sqlite", "postgres"]) {
		const compare = identityComparator(dialect, columns("utf8mb4_0900_ai_ci"));
		assert.equal(compare.id("ext-I"), "ext-I");
		assert.equal(compare.identity("m1", "imap.example.com", "User "), JSON.stringify(["m1", "imap.example.com", "User "]));
	}
	// No MySQL metadata at all: exact, which accepts rather than refuses.
	assert.deepEqual(identityComparator("mysql", null).identity("m1", "h", "u "), JSON.stringify(["m1", "h", "u "]));
});

test("only utf8mb4_bin is mirrored: case-sensitive, with trailing ASCII spaces folded when PAD SPACE", () => {
	const compare = identityComparator("mysql", columns("utf8mb4_bin", { padsSpaces: true }));
	// Case stays significant, and only a trailing ASCII space is padding (never NBSP).
	assert.notEqual(compare.identity("m1", "imap.example.com", "User"), compare.identity("m1", "imap.example.com", "user"));
	assert.equal(compare.identity("m1", "imap.example.com", "user"), compare.identity("m1", "imap.example.com", "user  "));
	assert.notEqual(compare.identity("m1", "imap.example.com", "user"), compare.identity("m1", "imap.example.com", "user\u00a0"));
	assert.notEqual(compare.id("ext-I"), compare.id("ext-i"));
});

test("the same binary collation declared NO PAD does not fold trailing spaces", () => {
	const compare = identityComparator("mysql", columns("utf8mb4_bin", { padsSpaces: false }));
	assert.notEqual(compare.identity("m1", "h", "user"), compare.identity("m1", "h", "user "));
});

test("every other MySQL collation is compared exactly, so a valid backup is never refused", () => {
	// The Turkish collation holds `I` and `i` apart — a JavaScript `toLowerCase()` would call them duplicates.
	for (const collation of ["utf8mb4_tr_0900_ai_ci", "utf8mb4_0900_ai_ci", "utf8mb4_0900_as_cs", "utf8mb4_general_ci", "utf8mb4_0900_bin", "some_future_ci", null]) {
		const compare = identityComparator("mysql", columns(collation, { padsSpaces: true }));
		assert.notEqual(compare.id("ext-I"), compare.id("ext-i"), String(collation));
		assert.notEqual(compare.identity("m1", "h", "user"), compare.identity("m1", "h", "USER"), String(collation));
		assert.notEqual(compare.identity("m1", "h", "user"), compare.identity("m1", "h", "user "), String(collation));
	}
	// A mixed schema, like this table's own: `id`/`mailbox_id` on `_ci` (compared exactly), the login on
	// `utf8mb4_bin`. With NO PAD nothing folds; with PAD SPACE only the binary columns fold trailing spaces.
	const noPad = identityComparator("mysql", columns("utf8mb4_0900_ai_ci", { host: "utf8mb4_bin", username: "utf8mb4_bin", padsSpaces: false }));
	assert.notEqual(noPad.identity("m1", "h", "user"), noPad.identity("M1", "h", "user"));
	assert.notEqual(noPad.identity("m1", "h", "user"), noPad.identity("m1", "h", "user "));
	const pad = identityComparator("mysql", columns("utf8mb4_0900_ai_ci", { host: "utf8mb4_bin", username: "utf8mb4_bin", padsSpaces: true }));
	assert.equal(pad.identity("m1", "h", "user"), pad.identity("m1", "h", "user "));
	assert.notEqual(pad.identity("m1", "h", "user"), pad.identity("M1", "h", "user"));
});

test("a metadata denial degrades to exact comparison", async () => {
	// Any failure while reading information_schema must leave the comparison exact rather than guessed.
	const failing = {
		prepare() {
			throw new Error("denied");
		},
	};
	assert.equal(await externalAccountCollations(failing), null);
	const refusing = {
		prepare: () => ({
			all: async () => {
				throw new Error("denied");
			},
		}),
	};
	assert.equal(await externalAccountCollations(refusing), null);
});

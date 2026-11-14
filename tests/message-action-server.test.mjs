import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const directory = mkdtempSync(join(root, "node_modules", "mailflare-undo-server-"));
after(() => rmSync(directory, { recursive: true, force: true }));

await build({
	stdin: {
		contents: `
			export { signUndoToken, verifyUndoToken } from "./src/lib/messages/actions/token.ts";
			export {
				claimMessageActionUndoToken, releaseMessageActionUndoClaim, pruneExpiredMessageActionUndoClaims,
			} from "./src/lib/messages/actions/claims.ts";
			export { planUndoRecord, getChangedStateFields } from "./src/lib/messages/actions/definitions.ts";
		`,
		resolveDir: root,
		sourcefile: "message-action-server-entry.ts",
	},
	outfile: join(directory, "entry.mjs"),
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node24",
	tsconfig: join(root, "tsconfig.json"),
	packages: "external",
	logLevel: "silent",
	plugins: [{
		name: "claims-db",
		setup(builder) {
			builder.onResolve({ filter: /^@\/db$/ }, () => ({ path: "claims-db", namespace: "mock" }));
			builder.onLoad({ filter: /.*/, namespace: "mock" }, () => ({
				contents: `export function getDb() { return globalThis.__claimsDb; }`,
				loader: "js",
			}));
		},
	}],
});
const m = await import(pathToFileURL(join(directory, "entry.mjs")).href);

const sqlite = new Database(":memory:");
sqlite.exec(`
	CREATE TABLE message_action_undo_claims (
		nonce text PRIMARY KEY NOT NULL,
		user_id text NOT NULL,
		expires_at integer NOT NULL
	);
	CREATE INDEX message_action_undo_claims_expires_idx ON message_action_undo_claims (expires_at);
`);
globalThis.__claimsDb = drizzle(sqlite);
after(() => sqlite.close());

const state = (overrides = {}) => ({
	status: "received",
	read: false,
	starred: false,
	folderId: null,
	snoozedUntil: null,
	...overrides,
});
const record = (previous, applied) => ({ id: "m1", mailboxId: "mb1", previous, applied });
const target = (overrides = {}) => ({
	id: "m1",
	mailboxId: "mb1",
	direction: "inbound",
	status: "received",
	read: false,
	starred: false,
	folderId: null,
	snoozedUntil: null,
	...overrides,
});

test("token v2 carries the user and nonce and rejects old or tampered payloads", async () => {
	const payload = {
		v: 2,
		issuedAt: Date.now(),
		action: "read",
		userId: "user-1",
		nonce: "nonce-1",
		records: [record(state(), state({ read: true }))],
	};
	const token = await m.signUndoToken("secret", payload);
	assert.deepEqual(await m.verifyUndoToken("secret", token), payload);
	assert.equal(await m.verifyUndoToken("other-secret", token), null);
	assert.equal(await m.verifyUndoToken("secret", `${token.slice(0, -2)}xx`), null);
	assert.equal(await m.verifyUndoToken("secret", token, payload.issuedAt + 11 * 60_000), null);
	// Tokens from the previous format are not accepted.
	const oldToken = await m.signUndoToken("secret", { ...payload, v: 1 });
	assert.equal(await m.verifyUndoToken("secret", oldToken), null);
});

test("a claim nonce is single-use across users and can be released for a retry", async () => {
	const expiresAt = new Date(Date.now() + 60_000);
	assert.equal(await m.claimMessageActionUndoToken({}, { nonce: "retry-nonce", userId: "u1", expiresAt }), "claimed");
	assert.equal(await m.claimMessageActionUndoToken({}, { nonce: "retry-nonce", userId: "u2", expiresAt }), "duplicate");
	await m.releaseMessageActionUndoClaim({}, { nonce: "retry-nonce", userId: "u2" });
	// Releasing another user's claim must not remove the owner's claim.
	assert.equal(await m.claimMessageActionUndoToken({}, { nonce: "retry-nonce", userId: "u1", expiresAt }), "duplicate");
	await m.releaseMessageActionUndoClaim({}, { nonce: "retry-nonce", userId: "u1" });
	assert.equal(await m.claimMessageActionUndoToken({}, { nonce: "retry-nonce", userId: "u1", expiresAt }), "claimed");
});

test("expired claims are pruned opportunistically so a nonce can be reused after expiry", async () => {
	const expired = new Date(Date.now() - 60_000);
	assert.equal(await m.claimMessageActionUndoToken({}, { nonce: "expired-nonce", userId: "u1", expiresAt: expired }), "claimed");
	const future = new Date(Date.now() + 60_000);
	assert.equal(await m.claimMessageActionUndoToken({}, { nonce: "expired-nonce", userId: "u1", expiresAt: future }), "claimed");
	await m.pruneExpiredMessageActionUndoClaims({}, new Date(Date.now() + 120_000));
	assert.equal(await m.claimMessageActionUndoToken({}, { nonce: "expired-nonce", userId: "u1", expiresAt: future }), "claimed");
});

test("undo plans restore only changed fields and ignore removed folders for read-only undo", () => {
	const archivePrevious = state({ status: "received", folderId: "folder-1" });
	const archiveApplied = state({ status: "archived", folderId: null });
	const plan = m.planUndoRecord(
		record(archivePrevious, archiveApplied),
		target({ status: "archived", folderId: null }),
		{ canRead: true, canManage: true },
		"mb1",
	);
	assert.deepEqual(plan.patch, { status: "received", folderId: "folder-1" });
	assert.deepEqual(plan.fields, ["status", "folderId"]);

	const readPrevious = state({ folderId: "removed-folder" });
	const readApplied = state({ folderId: "removed-folder", read: true });
	const readPlan = m.planUndoRecord(
		record(readPrevious, readApplied),
		target({ folderId: "removed-folder", read: true }),
		{ canRead: true, canManage: true },
		undefined,
	);
	assert.deepEqual(readPlan.patch, { read: false });
});

test("every dialect carries the undo-claim table and bundle", async () => {
	const files = {
		sqlite: join(root, "drizzle/migrations/0088_message_action_undo_claims.sql"),
		postgres: join(root, "drizzle/migrations-pg/0012_message_action_undo_claims.sql"),
		mysql: join(root, "drizzle/migrations-mysql/0012_message_action_undo_claims.sql"),
	};
	for (const [dialect, file] of Object.entries(files)) {
		const sql = readFileSync(file, "utf8");
		assert.match(sql, /CREATE TABLE [`"]message_action_undo_claims[`"]/, dialect);
		assert.match(sql, /nonce/, dialect);
		assert.match(sql, /user_id/, dialect);
		assert.match(sql, /expires_at/, dialect);
		assert.match(sql, /message_action_undo_claims_expires_idx/, dialect);
	}
	const backupSource = readFileSync(join(root, "src/lib/backups/export.ts"), "utf8");
	assert.match(backupSource, /"message_action_undo_claims"/);
});

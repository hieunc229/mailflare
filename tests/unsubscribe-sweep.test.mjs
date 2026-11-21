import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(join(tmpdir(), "mailflare-unsubscribe-sweep-"));
after(() => rmSync(outDir, { recursive: true, force: true }));

await build({
	stdin: {
		contents: `
			export { senderTrashCondition } from "./src/app/api/messages/[messageId]/unsubscribe/utils.ts";
			import { SQLiteSyncDialect } from "drizzle-orm/sqlite-core";
			const dialect = new SQLiteSyncDialect();
			export const render = (fragment) => dialect.sqlToQuery(fragment);
		`,
		resolveDir: root,
		sourcefile: "unsubscribe-sweep-entry.js",
	},
	outfile: join(outDir, "entry.mjs"),
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node22",
	tsconfig: join(root, "tsconfig.json"),
	logLevel: "silent",
});
const { senderTrashCondition, render } = await import(pathToFileURL(join(outDir, "entry.mjs")).href);

function matches(sender, rows) {
	const db = new DatabaseSync(":memory:");
	db.exec('CREATE TABLE messages (id TEXT, mailbox_id TEXT, direction TEXT, from_addr TEXT, starred INTEGER, folder_id TEXT, status TEXT)');
	rows.forEach(([id, from, extra = {}]) => {
		db.prepare("INSERT INTO messages VALUES (?, 'mbx', ?, ?, 0, NULL, ?)").run(id, extra.direction ?? "inbound", from, extra.status ?? "received");
	});
	const query = render(senderTrashCondition("mbx", sender));
	return db.prepare(`SELECT id FROM messages WHERE ${query.sql}`).all(...query.params).map((row) => row.id).sort();
}

test("only the exact sender address matches, bare or inside a display name", () => {
	const rows = [
		["a", "sale@shop.com"],
		["b", '"Shop Sale" <Sale@Shop.com>'],
		["c", "presale@shop.com"],
		["d", "sale@shop.com.evil.net"],
		["e", '"x sale@shop.com" <other@elsewhere.com>'],
		["f", "sale@shop.com", { direction: "outbound" }],
		["g", "sale@shop.com", { status: "trash" }],
	];
	assert.deepEqual(matches("sale@shop.com", rows), ["a", "b"]);
});

test("underscores and percent signs in the address are literal", () => {
	assert.deepEqual(matches("no_reply@x.com", [["a", "<no_reply@x.com>"], ["b", "noXreply@x.com"], ["c", "no_reply@x.com"]]), ["a", "c"]);
});

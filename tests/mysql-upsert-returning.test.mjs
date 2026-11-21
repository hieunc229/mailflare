import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const directory = mkdtempSync(join(root, "node_modules", "mailflare-mysql-upsert-"));
after(() => rmSync(directory, { recursive: true, force: true }));
process.env.MAILFLARE_DB_DIALECT = "mysql";
await build({
	stdin: {
		contents: `
			export { openExternalDatabase } from "./src/db/external.ts";
			export { resolveDatabaseConfig } from "./src/db/dialect.ts";
			export { setFollowUp } from "./src/lib/follow-ups/service.ts";
		`,
		resolveDir: root,
		sourcefile: "mysql-upsert-entry.ts",
	},
	outfile: join(directory, "entry.mjs"),
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node22",
	tsconfig: join(root, "tsconfig.json"),
	packages: "external",
	logLevel: "silent",
});
const { openExternalDatabase, resolveDatabaseConfig, setFollowUp } = await import(pathToFileURL(join(directory, "entry.mjs")).href);

/** In-memory stand-in for follow_ups with UNIQUE(message_id), answering the statements the MySQL shim sends. */
function fakeFollowUps() {
	const rows = new Map();
	const pick = (row, mode) => (mode === "array" ? [row.id, row.status, row.due_at] : row);
	return async (text, params, mode) => {
		if (/^insert into `follow_ups`/.test(text)) {
			const [id, messageId, userId, dueAt] = params;
			const existing = [...rows.values()].find((row) => row.message_id === messageId);
			if (existing) {
				Object.assign(existing, { due_at: dueAt, status: "pending", user_id: userId });
				return { rows: [], affectedRows: 2 };
			}
			rows.set(id, { id, message_id: messageId, user_id: userId, due_at: dueAt, status: "pending" });
			return { rows: [], affectedRows: 1 };
		}
		const select = /^select .* from `follow_ups` where \(?`follow_ups`.`(id|message_id)` (in|=)/.exec(text);
		if (select) {
			const column = select[1];
			return { rows: [...rows.values()].filter((row) => params.includes(row[column])).map((row) => pick(row, mode)), affectedRows: 0 };
		}
		throw new Error(`unexpected SQL: ${text}`);
	};
}

test("re-arming a follow-up on MySQL returns the existing reminder", async () => {
	const DB = openExternalDatabase(resolveDatabaseConfig({ DATABASE_URL: "mysql://u:p@h/db" }), true);
	DB.sqlExecutor.query = fakeFollowUps();
	const env = { DB };
	const first = await setFollowUp(env, { messageId: "msg_1", userId: "u1", days: 3, from: new Date("2026-01-01T00:00:00Z") });
	const second = await setFollowUp(env, { messageId: "msg_1", userId: "u1", days: 7, from: new Date("2026-01-01T00:00:00Z") });
	assert.equal(second.id, first.id);
	assert.equal(second.status, "pending");
	assert.notEqual(second.dueAt, first.dueAt);
});

import assert from "node:assert/strict";
import test from "node:test";
import { loadApp } from "./helpers/real-db.mjs";

const { app, newDatabase } = await loadApp("permanent-delete-budget", `
	export { permanentlyDeleteMessages } from "./src/lib/email/permanent-delete.ts";
`);

const seed = `
	INSERT INTO users (id, email, name, password_hash, created_at) VALUES ('u', 'u@example.com', 'U', 'x', 1);
	INSERT INTO domains (id, user_id, hostname, zone_id, created_at) VALUES ('d', 'u', 'example.com', 'zone', 1);
	INSERT INTO mailboxes (id, user_id, domain_id, local_part, type, created_at) VALUES ('mb', 'u', 'd', 'me', 'personal', 1);
`;

// The bulk route accepts 5000 ids and the platform allows 1000 subrequests per request, so the
// D1 calls (a batch counts as one) plus R2 calls must stay well under that.
test("5000 permanent deletes stay under the subrequest cap, with every row and object gone", async (t) => {
	const { env, sqlite, db } = await newDatabase(t, seed);
	const MESSAGES = 5000;
	sqlite.exec(`
		WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i + 1 < ${MESSAGES})
		INSERT INTO messages (id, mailbox_id, user_id, direction, from_addr, to_addr, subject, status, raw_r2_key, created_at)
		SELECT 'm' || i, 'mb', 'u', 'inbound', 'a@b.test', 'me@example.com', 's', 'trash', 'raw/m' || i, 1 FROM n;
		WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i + 1 < ${MESSAGES})
		INSERT INTO message_attachments (id, message_id, filename, content_type, size, r2_key, created_at)
		SELECT 'a' || i, 'm' || i, 'a.pdf', 'application/pdf', 3, 'att/m' || i, 1 FROM n;
	`);
	const rows = Array.from({ length: MESSAGES }, (_, i) => ({ id: `m${i}`, mailboxId: "mb", rawR2Key: `raw/m${i}`, status: "trash" }));

	const deleted = [];
	let r2Calls = 0;
	env.BUCKET = { delete: async (keys) => { r2Calls += 1; deleted.push(...[].concat(keys)); } };
	let d1Calls = 0;
	let maxParams = 0;
	const database = env.DB;
	const batch = database.batch.bind(database);
	let inBatch = false;
	database.batch = async (statements) => {
		d1Calls += 1;
		inBatch = true;
		try { return await batch(statements); } finally { inBatch = false; }
	};
	const prepare = database.prepare.bind(database);
	database.prepare = (sql) => {
		const statement = prepare(sql);
		const bind = statement.bind.bind(statement);
		statement.bind = (...values) => {
			maxParams = Math.max(maxParams, values.length);
			const bound = bind(...values);
			// run/all/first/raw are standalone calls; a batch runs its statements internally and counts once.
			for (const method of ["run", "all", "first", "raw"]) {
				const original = bound[method]?.bind(bound);
				if (original) bound[method] = (...args) => { if (!inBatch) d1Calls += 1; return original(...args); };
			}
			return bound;
		};
		return statement;
	};

	await app.permanentlyDeleteMessages(env, db, "u", rows, "bulk");
	assert.ok(d1Calls + r2Calls < 1000, `d1 ${d1Calls} + r2 ${r2Calls}`);
	assert.ok(maxParams <= 100, `max params ${maxParams}`);
	assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM messages").get().n, 0);
	assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM audit_logs").get().n, MESSAGES);
	assert.equal(deleted.length, MESSAGES * 2);
});

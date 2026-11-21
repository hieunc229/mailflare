import assert from "node:assert/strict";
import test from "node:test";
import { loadApp, sharedMailboxSeed } from "./helpers/real-db.mjs";

// D1 refuses a statement with more than 100 bound parameters. The in-memory SQLite used by the other
// tests accepts far more, so these tests count the parameters of every statement that actually runs
// and fail when the draft-visibility predicate (or a batch sized without it) pushes one past 100.
const D1_MAX_PARAMS = 100;
const { app, newDatabase } = await loadApp("d1-param-budget", `
	export { emailGet, threadGet } from "./src/lib/jmap/emails.ts";
	export { currentChangeScope, emailChangesSince, threadChangesSince } from "./src/lib/jmap/changes.ts";
	export { addressesSeenInMailbox } from "./src/app/api/contacts/utils.ts";
	export { draftsVisibleTo, DRAFT_FILTER_PARAMS } from "./src/lib/email/draft-access.ts";
	export { messages } from "./src/db/schema/index.ts";
`);

const user = (id) => ({ id, email: `${id}@example.com`, role: "user" });
const jmap = (db, env, id) => ({
	env, db, accountId: "acct", origin: "http://localhost", createdIds: {}, memo: undefined,
	auth: { userId: id, user: user(id), scopes: ["jmap"], mailboxIds: null },
});
const ids = (count) => Array.from({ length: count }, (_, i) => `m-${String(i).padStart(4, "0")}`);

// Records the largest parameter list handed to the database.
function watch(env) {
	const peak = { count: 0, sql: "" };
	const prepare = env.DB.prepare.bind(env.DB);
	env.DB.prepare = (sql) => {
		const statement = prepare(sql);
		const bind = statement.bind.bind(statement);
		statement.bind = (...values) => {
			if (values.length > peak.count) Object.assign(peak, { count: values.length, sql });
			return bind(...values);
		};
		return statement;
	};
	return peak;
}

async function setup(t) {
	const rows = ids(260).map((id, index) => `('${id}', 'admin', 'mb-team', 'inbound', 'x@example.net', 'team@example.com', 'S', 'b', 'received', ${index + 2})`);
	const fixture = await newDatabase(t, `${sharedMailboxSeed("read_only")}
		INSERT INTO messages (id, user_id, mailbox_id, direction, from_addr, to_addr, subject, text_body, status, created_at) VALUES ${rows.join(",")};`);
	return { ...fixture, peak: watch(fixture.env) };
}

function assertBudget(peak, label) {
	assert.ok(peak.count <= D1_MAX_PARAMS, `${label}: ${peak.count} bound parameters (> ${D1_MAX_PARAMS}) in: ${peak.sql}`);
	assert.ok(peak.count >= 90, `${label}: only ${peak.count} parameters, so the batch path was not exercised`);
}

test("the draft predicate binds exactly the user id, and the exported budget says so", async (t) => {
	const { db } = await newDatabase(t, "");
	const { params } = db.select({ id: app.messages.id }).from(app.messages).where(app.draftsVisibleTo("u1")).toSQL();
	assert.deepEqual(params, ["u1"]);
	assert.equal(app.DRAFT_FILTER_PARAMS, params.length);
});

test("Email/get at the maximum batch stays within the D1 parameter limit", async (t) => {
	const { env, db, peak } = await setup(t);
	const result = await app.emailGet(jmap(db, env, "delegate"), { ids: ids(200), properties: ["keywords"] });
	assert.equal(result.list.length, 200);
	assertBudget(peak, "Email/get");
});

test("Thread/get at the maximum batch stays within the D1 parameter limit", async (t) => {
	const { env, db, peak } = await setup(t);
	const result = await app.threadGet(jmap(db, env, "delegate"), { ids: ids(200) });
	assert.equal(result.list.length, 200);
	assertBudget(peak, "Thread/get");
});

test("Email/changes and Thread/changes stay within the D1 parameter limit", async (t) => {
	const { env, db, peak } = await setup(t);
	const since = `c1:0:${(await app.currentChangeScope(jmap(db, env, "delegate"))).fingerprint}`;
	const email = await app.emailChangesSince(jmap(db, env, "delegate"), { sinceState: since, maxChanges: 5000 });
	assert.equal(email.created.length, 260);
	assertBudget(peak, "Email/changes");
	peak.count = 0;
	const thread = await app.threadChangesSince(jmap(db, env, "delegate"), { sinceState: since, maxChanges: 5000 });
	assert.equal(thread.created.length, 260);
	assertBudget(peak, "Thread/changes");
});

test("the seen-address check stays within the D1 parameter limit", async (t) => {
	const { env, db, peak } = await setup(t);
	const emails = Array.from({ length: 60 }, (_, i) => `person${i}@example.net`);
	await app.addressesSeenInMailbox(db, "mb-team", emails, "delegate");
	assert.ok(peak.count <= D1_MAX_PARAMS, `${peak.count} bound parameters in: ${peak.sql}`);
	assert.ok(env);
});

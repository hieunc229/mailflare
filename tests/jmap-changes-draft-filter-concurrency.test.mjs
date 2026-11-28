import assert from "node:assert/strict";
import test from "node:test";
import { loadApp, sharedMailboxSeed } from "./helpers/real-db.mjs";

// The draft-visibility lookup of the change feeds checks ids in batches of at most 99. The batches
// must overlap (so a long feed is not one round trip after another) without exceeding 5 in flight.
const { app, newDatabase } = await loadApp("jmap-changes-concurrency", `
	export { currentChangeScope, emailChangesSince, mailboxChangesSince } from "./src/lib/jmap/changes.ts";
`);

const jmap = (db, env, id) => ({
	env, db, accountId: "acct", origin: "http://localhost", createdIds: {}, memo: undefined,
	auth: { userId: id, user: { id, email: `${id}@example.com`, role: "user" }, scopes: ["jmap"], mailboxIds: null },
});
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Delays every statement on messages and records how many run at once.
function watch(env) {
	const state = { inFlight: 0, peak: 0 };
	const prepare = env.DB.prepare.bind(env.DB);
	const wrap = (statement, sql) => new Proxy(statement, {
		get(target, prop) {
			const value = target[prop];
			if (prop === "bind") return (...args) => wrap(value.apply(target, args), sql);
			if (["all", "run", "raw", "first"].includes(prop) && /"messages"/.test(sql)) {
				return async (...args) => {
					state.peak = Math.max(state.peak, ++state.inFlight);
					try {
						await sleep(5);
						return await value.apply(target, args);
					} finally {
						state.inFlight -= 1;
					}
				};
			}
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
	env.DB.prepare = (sql) => wrap(prepare(sql), sql);
	return state;
}

async function setup(t) {
	const rows = Array.from({ length: 260 }, (_, index) => `('m-${String(index).padStart(4, "0")}', 'admin', 'mb-team', 'inbound', 'x@example.net', 'team@example.com', 'S', 'b', 'received', ${index + 2})`);
	const fixture = await newDatabase(t, `${sharedMailboxSeed("read_only")}
		INSERT INTO messages (id, user_id, mailbox_id, direction, from_addr, to_addr, subject, text_body, status, created_at) VALUES ${rows.join(",")};`);
	const since = `c1:0:${(await app.currentChangeScope(jmap(fixture.db, fixture.env, "delegate"))).fingerprint}`;
	return { ...fixture, since, state: watch(fixture.env) };
}

test("Mailbox/changes overlaps its draft lookups", async (t) => {
	const { env, db, since, state } = await setup(t);
	const result = await app.mailboxChangesSince(jmap(db, env, "delegate"), { sinceState: since, maxChanges: 5000 });
	assert.ok(state.peak >= 2, `peak ${state.peak}`);
	assert.ok(state.peak <= 5, `peak ${state.peak}`);
	assert.equal(result.hasMoreChanges, false);
	assert.ok(result.updated.length > 0);
});

test("Email/changes result is unchanged", async (t) => {
	const { env, db, since, state } = await setup(t);
	const result = await app.emailChangesSince(jmap(db, env, "delegate"), { sinceState: since, maxChanges: 5000 });
	assert.equal(result.created.length, 260);
	assert.ok(state.peak >= 2 && state.peak <= 5, `peak ${state.peak}`);
});

test("another user's draft stays hidden", async (t) => {
	const { env, db, sqlite, since } = await setup(t);
	sqlite.exec(`INSERT INTO messages (id, user_id, mailbox_id, direction, from_addr, to_addr, subject, text_body, status, private_draft, created_at) VALUES ('draft-x', 'admin', 'mb-team', 'outbound', 'team@example.com', 'x@example.net', 'S', 'b', 'draft', 1, 999)`);
	const result = await app.emailChangesSince(jmap(db, env, "delegate"), { sinceState: since, maxChanges: 5000 });
	assert.equal(result.created.includes("draft-x"), false);
	assert.equal(result.created.length, 260);
});

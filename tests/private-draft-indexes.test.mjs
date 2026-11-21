import assert from "node:assert/strict";
import test from "node:test";
import { and, count, eq } from "drizzle-orm";
import { loadApp, sharedMailboxSeed } from "./helpers/real-db.mjs";

// The draft filter (user_id = ? OR NOT private_draft) must not cost the counts and navigation
// queries their covering indexes: both stay "USING COVERING INDEX" on the real statements.
const mocks = {
	"@/lib/cloudflare": "export function getEnv(){return globalThis.ixEnv}",
	"@/lib/auth/cookies": "export async function getCurrentUser(){return globalThis.ixUser}",
};
const { app, newDatabase } = await loadApp("private-draft-indexes", `
	export * as counts from "./src/app/api/messages/counts/route.ts";
	export * as navigation from "./src/app/api/messages/navigation/route.ts";
	export { draftsVisibleTo } from "./src/lib/email/draft-access.ts";
	export { messages } from "./src/db/schema/index.ts";
`, { mocks });

// Runs a request and returns the query plan of every statement that read from messages.
async function plans(t, call) {
	const { env, sqlite } = await newDatabase(t, sharedMailboxSeed("read_only"));
	globalThis.ixEnv = env;
	globalThis.ixUser = { id: "delegate", email: "delegate@example.com", role: "user" };
	const seen = [];
	const prepare = env.DB.prepare.bind(env.DB);
	env.DB.prepare = (sql) => {
		const statement = prepare(sql);
		const bind = statement.bind.bind(statement);
		statement.bind = (...values) => {
			if (/from "?`?messages/i.test(sql) && /^select/i.test(sql)) seen.push({ sql, values });
			return bind(...values);
		};
		return statement;
	};
	assert.equal((await call()).status, 200);
	return seen.map(({ sql, values }) => ({ sql, plan: sqlite.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...values).map((row) => row.detail).join(" | ") }));
}

test("folder counts group straight off the counts index", async (t) => {
	const result = await plans(t, () => app.counts.GET(new Request("http://localhost/api/messages/counts?mailboxId=mb-team")));
	const grouped = result.find((entry) => /group by/i.test(entry.sql));
	assert.ok(grouped, "the counts statement ran");
	console.log("counts plan (production statement):", grouped.plan);
	assert.match(grouped.plan, /USING INDEX messages_counts_cover_idx \(mailbox_id=\?\)/);
	assert.doesNotMatch(grouped.plan, /TEMP B-TREE/);
});

// The production statement also reads messages.id for the scheduled-send subquery, which no index here
// carries (on main too), so SQLite never labels it covering. Without that one column the same query,
// with the draft filter, must be covered: the filter itself costs no table lookups.
test("the counts grouping with the draft filter is covered by the counts index", async (t) => {
	const { db, sqlite } = await newDatabase(t, sharedMailboxSeed("read_only"));
	const { sql, params } = db
		.select({ mailboxId: app.messages.mailboxId, folderId: app.messages.folderId, direction: app.messages.direction, status: app.messages.status, read: app.messages.read, starred: app.messages.starred, snoozedUntil: app.messages.snoozedUntil, total: count() })
		.from(app.messages)
		.where(and(eq(app.messages.mailboxId, "mb-team"), app.draftsVisibleTo("delegate")))
		.groupBy(app.messages.mailboxId, app.messages.folderId, app.messages.direction, app.messages.status, app.messages.read, app.messages.starred, app.messages.snoozedUntil)
		.toSQL();
	const plan = sqlite.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params).map((row) => row.detail).join(" | ");
	console.log("counts plan (without the scheduled subquery):", plan);
	assert.match(plan, /USING COVERING INDEX messages_counts_cover_idx/);
	assert.doesNotMatch(plan, /TEMP B-TREE/);
});

test("message navigation reads the covering index", async (t) => {
	const result = await plans(t, () => app.navigation.GET(new Request("http://localhost/api/messages/navigation?folder=archived&mailboxId=mb-team")));
	const nav = result.find((entry) => /order by/i.test(entry.sql));
	assert.ok(nav, "the navigation statement ran");
	console.log("navigation plan:", nav.plan);
	assert.match(nav.plan, /USING COVERING INDEX messages_nav_cover_idx/);
});

test("inbox navigation reads the covering index without a sort", async (t) => {
	const result = await plans(t, () => app.navigation.GET(new Request("http://localhost/api/messages/navigation?folder=inbox&mailboxId=mb-team")));
	const nav = result.find((entry) => /order by/i.test(entry.sql));
	console.log("inbox navigation plan:", nav.plan);
	assert.match(nav.plan, /USING COVERING INDEX messages_nav_cover_idx/);
});

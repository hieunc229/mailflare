import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * JMAP creation ids and result references index plain objects with client
 * keys, so inherited Object.prototype members must read as absent and
 * "__proto__" keys must never reach a [[Set]] write. Without that, a
 * "#constructor" id resolves a Function into the method arguments (a client
 * error surfacing as a serverFail) and a "__proto__" entry in
 * request.createdIds rewrites the map's prototype, forging later "#x" lookups.
 * These tests pin the contract on an in-memory SQLite database; no Workers
 * binding is touched.
 */
const outDir = mkdtempSync(join(root, "node_modules", "mailflare-jmap-created-ids-test-"));
after(() => rmSync(outDir, { recursive: true, force: true }));

await build({
	stdin: {
		contents: `
			export { SqliteDatabase } from "./server/runtime/sqlite-database.ts";
			export { applyMigrations } from "./server/runtime/migrate.ts";
			export { getDb } from "./src/db/index.ts";
			export { processRequest } from "./src/lib/jmap/processor.ts";
		`,
		resolveDir: root,
		sourcefile: "jmap-created-ids-test-entry.ts",
	},
	outfile: join(outDir, "entry.mjs"),
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node24",
	tsconfig: join(root, "tsconfig.json"),
	packages: "external",
	alias: { "next/headers": "next/headers.js", "next/server": "next/server.js", "cloudflare:workers": "./server/runtime/cloudflare-workers.ts" },
	logLevel: "silent",
});

const { SqliteDatabase, applyMigrations, getDb, processRequest } = await import(pathToFileURL(join(outDir, "entry.mjs")).href);

const MAILBOX = "mbx_test";
const USING = ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail"];

async function fixture(t) {
	const database = new SqliteDatabase(":memory:");
	await applyMigrations(database, join(root, "drizzle/migrations"));
	t.after(() => database.db.close());
	database.db.exec(`
		INSERT INTO users (id, email, password_hash, name, role, is_primary_admin, created_at) VALUES
			('admin', 'owner@one.test', 'hash', 'Owner', 'admin', 1, 1);
		INSERT INTO domains (id, user_id, hostname, zone_id, status, created_at) VALUES
			('one', 'admin', 'one.test', 'zone-one', 'active', 1);
		INSERT INTO mailboxes (id, user_id, domain_id, local_part, display_name, use_all_domains, type, disabled, created_at) VALUES
			('${MAILBOX}', 'admin', 'one', 'support', 'Support', 1, 'personal', 0, 1);
	`);
	const env = { DB: database };
	const ctx = {
		env,
		db: getDb(env),
		auth: { userId: "admin", email: "owner@one.test", scopes: ["jmap"], mailboxIds: null, user: { id: "admin", email: "owner@one.test", role: "admin" } },
		accountId: "admin",
		origin: "http://test",
		createdIds: {},
	};
	return { ctx };
}

const call = (ctx, request) => processRequest(ctx, { using: USING, ...request }).then((response) => response.methodResponses);

test("a creation id naming an Object.prototype member stays an unresolved string", async (t) => {
	const { ctx } = await fixture(t);
	const [get] = await call(ctx, {
		methodCalls: [["Mailbox/get", { accountId: "admin", ids: ["#constructor"] }, "c1"]],
	});
	assert.equal(get[0], "Mailbox/get");
	assert.deepEqual(get[1].notFound, ["#constructor"], "the literal id is reported not found, never a Function");
});

test("a creation id in a destroy list reads as absent, not as an inherited Function", async (t) => {
	const { ctx } = await fixture(t);
	const [set] = await call(ctx, {
		methodCalls: [["Mailbox/set", { accountId: "admin", destroy: ["#hasOwnProperty"] }, "c1"]],
	});
	assert.equal(set[0], "Mailbox/set");
	assert.equal(set[1].notDestroyed["#hasOwnProperty"].type, "notFound");
	assert.deepEqual(set[1].destroyed, []);
});

test("a creation id inside a nested filter arg cannot reach the prototype chain", async (t) => {
	const { ctx } = await fixture(t);
	const [query] = await call(ctx, {
		methodCalls: [["Email/query", { accountId: "admin", filter: { inMailbox: "#toString" } }, "c1"]],
	});
	assert.equal(query[0], "error");
	assert.equal(query[1].type, "invalidArguments", "an unknown mailbox is a client error, not a serverFail");
});

test("result references cannot walk off the response's own properties", async (t) => {
	const { ctx } = await fixture(t);
	const [, ctor, proto] = await call(ctx, {
		methodCalls: [
			["Core/echo", { a: 1 }, "c0"],
			["Core/echo", { "#x": { resultOf: "c0", name: "Core/echo", path: "/constructor" } }, "c1"],
			["Core/echo", { "#y": { resultOf: "c0", name: "Core/echo", path: "/__proto__" } }, "c2"],
		],
	});
	assert.equal(ctor[0], "Core/echo");
	assert.equal(ctor[1].x, undefined, "the Object constructor must not land in the arguments");
	assert.equal(proto[0], "Core/echo");
	assert.equal(proto[1].y, undefined, "the prototype object itself must not land in the arguments");
});

test("request.createdIds cannot plant a __proto__ key that forges later lookups", async (t) => {
	const { ctx } = await fixture(t);
	// Built through JSON.parse like a real request body: "__proto__" is an own
	// enumerable key there, which is exactly what makes the merge dangerous.
	const createdIds = JSON.parse(`{"__proto__":{"x":"inj"},"seeded":"${MAILBOX}"}`);
	const [get] = await call(ctx, {
		createdIds,
		methodCalls: [["Mailbox/get", { accountId: "admin", ids: ["#seeded", "#x"] }, "c1"]],
	});
	assert.equal(get[0], "Mailbox/get");
	assert.equal(get[1].list.length, 1, "the legitimate creation id still resolves");
	assert.deepEqual(get[1].notFound, ["#x"], "a key living only on an injected prototype must stay absent");
	assert.equal(Object.getPrototypeOf(ctx.createdIds), Object.prototype, "the merge left the map's prototype alone");
});

test("a '#__proto__' result-reference key cannot write to the args prototype", async (t) => {
	const { ctx } = await fixture(t);
	const [bad, good] = await call(ctx, {
		methodCalls: [
			["Core/echo", { "#__proto__": { resultOf: "nope", name: "Core/echo", path: "/" }, keep: "yes" }, "c1"],
			["Core/echo", { still: "here" }, "c2"],
		],
	});
	assert.equal(bad[0], "Core/echo", "the dropped key does not fail the call");
	assert.equal(bad[1].keep, "yes");
	assert.equal(Object.getPrototypeOf(bad[1]), Object.prototype);
	assert.equal(good[1].still, "here", "a hostile call cannot poison a sibling call in the same request");
});

test("a method name from the prototype chain is not a method", async (t) => {
	const { ctx } = await fixture(t);
	const [ctor, has] = await call(ctx, {
		methodCalls: [
			["constructor", { accountId: "admin" }, "c1"],
			["hasOwnProperty", { accountId: "admin" }, "c2"],
		],
	});
	assert.equal(ctor[0], "error", "Object is not a JMAP handler and must not run as one");
	assert.equal(ctor[1].type, "unknownMethod");
	assert.equal(has[0], "error");
	assert.equal(has[1].type, "unknownMethod");
});

test("real creation ids still resolve across calls in the request", async (t) => {
	const { ctx } = await fixture(t);
	const [set, get] = await call(ctx, {
		methodCalls: [
			["Mailbox/set", { accountId: "admin", create: { draft1: { parentId: MAILBOX, name: "Sweep16" } } }, "c1"],
			["Mailbox/get", { accountId: "admin", ids: ["#draft1"] }, "c2"],
		],
	});
	assert.equal(set[0], "Mailbox/set");
	const createdId = set[1].created.draft1.id;
	assert.equal(get[0], "Mailbox/get");
	assert.equal(get[1].list.length, 1);
	assert.equal(get[1].list[0].id, createdId);
	assert.equal(get[1].list[0].name, "Sweep16");
	assert.deepEqual(get[1].notFound, []);
});

test("client supplied createdIds merge and echo without polluting the map", async (t) => {
	const { ctx } = await fixture(t);
	const createdIds = JSON.parse(`{"__proto__":{"x":"inj"},"seeded":"${MAILBOX}"}`);
	const response = await processRequest(ctx, {
		using: USING,
		createdIds,
		methodCalls: [["Mailbox/get", { accountId: "admin", ids: ["#seeded"] }, "c1"]],
	});
	assert.equal(response.methodResponses[0][1].list.length, 1);
	assert.deepEqual(response.createdIds, { seeded: MAILBOX });
});

test("valid nested result references still resolve", async (t) => {
	const { ctx } = await fixture(t);
	const [, deep] = await call(ctx, {
		methodCalls: [
			["Core/echo", { a: { b: ["x", "deep"] } }, "c0"],
			["Core/echo", { "#x": { resultOf: "c0", name: "Core/echo", path: "/a/b/1" } }, "c1"],
		],
	});
	assert.equal(deep[0], "Core/echo");
	assert.equal(deep[1].x, "deep");
});

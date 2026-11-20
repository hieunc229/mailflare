import assert from "node:assert/strict";
import test from "node:test";
import { DELEGATE, as, call, loadRoutes, request, seed } from "./promotions-route-harness.mjs";

const m = await loadRoutes("promotions-mode-api", `export * as route from "./src/app/api/mailboxes/[id]/promotions/route.ts";`);
const get = (id) => call(m.route.GET, request(`/api/mailboxes/${id}/promotions`), { id });
const put = (id, body, options) => call(m.route.PUT, request(`/api/mailboxes/${id}/promotions`, { method: "PUT", body, ...options }), { id });
const row = (database, id = "a") => database.db.prepare("SELECT * FROM mailbox_promotion_settings WHERE mailbox_id = ?").get(id);

test("GET defaults to off with an idle backfill when there is no row", async (t) => {
	await seed(t, m);
	assert.deepEqual(await get("a"), { status: 200, body: { mode: "off", backfill: { status: "idle", scanned: 0 } } });
});

test("GET is open to a read-only delegate and 404s for a mailbox the user cannot see", async (t) => {
	const database = await seed(t, m);
	database.db.prepare("INSERT INTO mailbox_promotion_settings (mailbox_id, mode, backfill_status, backfill_scanned, updated_at) VALUES ('s', 'show', 'running', 12, 1)").run();
	as(DELEGATE);
	assert.deepEqual(await get("s"), { status: 200, body: { mode: "show", backfill: { status: "running", scanned: 12 } } });
	assert.equal((await get("a")).status, 404);
});

test("GET reports off when the table is missing", async (t) => {
	const database = await seed(t, m);
	database.db.exec("DROP TABLE mailbox_promotion_settings");
	assert.deepEqual((await get("a")).body, { mode: "off", backfill: { status: "idle", scanned: 0 } });
});

test("PUT validates the body", async (t) => {
	await seed(t, m);
	for (const body of [{ mode: "on" }, {}, null]) assert.equal((await put("a", body)).status, 400);
	assert.equal((await call(m.route.PUT, new Request("https://mail.test/x", { method: "PUT", headers: { "Sec-Fetch-Site": "same-origin" }, body: "{nope" }), { id: "a" })).status, 400);
});

test("PUT needs the same origin and a session", async (t) => {
	const database = await seed(t, m);
	assert.equal((await put("a", { mode: "show" }, { origin: false })).status, 403);
	assert.equal(row(database), undefined);
	globalThis.__testUser = null;
	assert.equal((await put("a", { mode: "show" })).status, 401);
});

test("a read-only delegate cannot change the mode; full access can", async (t) => {
	const database = await seed(t, m);
	as(DELEGATE);
	assert.equal((await put("s", { mode: "show" })).status, 403);
	assert.equal(row(database, "s"), undefined);
	assert.equal((await put("a", { mode: "show" })).status, 404);
	database.db.prepare("UPDATE mailbox_access SET permission = 'full_access'").run();
	assert.equal((await put("s", { mode: "separate" })).status, 200);
	assert.equal(row(database, "s").mode, "separate");
});

test("the first move away from off queues the backfill; later changes keep it; a failed job restarts clean", async (t) => {
	const database = await seed(t, m);
	assert.deepEqual(await put("a", { mode: "show" }), { status: 200, body: { mode: "show", backfill: { status: "pending", scanned: 0 } } });
	database.db.prepare("UPDATE mailbox_promotion_settings SET backfill_status = 'running', backfill_scanned = 30, backfill_cursor = 'c' WHERE mailbox_id = 'a'").run();
	await put("a", { mode: "separate" });
	assert.deepEqual({ ...row(database) }, { ...row(database), mode: "separate", backfill_status: "running", backfill_scanned: 30, backfill_cursor: "c" });
	await put("a", { mode: "off" });
	database.db.prepare("UPDATE mailbox_promotion_settings SET backfill_status = 'failed', backfill_error = 'boom', backfill_stalls = 3 WHERE mailbox_id = 'a'").run();
	const failed = await get("a");
	assert.deepEqual(failed.body, { mode: "off", backfill: { status: "failed", scanned: 30, error: "boom" } });
	await put("a", { mode: "show" });
	assert.deepEqual({ ...row(database) }, { ...row(database), mode: "show", backfill_status: "pending", backfill_scanned: 0, backfill_cursor: null, backfill_error: null, backfill_stalls: 0 });
});

test("show and separate keep a running backfill's claim (updated_at is its fence); only off, or a restart, replaces it", async (t) => {
	const database = await seed(t, m);
	database.db.prepare("INSERT INTO mailbox_promotion_settings (mailbox_id, mode, backfill_status, backfill_scanned, updated_at) VALUES ('a', 'show', 'running', 30, 1000)").run();
	const stamp = () => row(database).updated_at;
	await put("a", { mode: "separate" });
	assert.equal(row(database).mode, "separate");
	assert.equal(stamp(), 1000);
	await put("a", { mode: "show" });
	await put("a", { mode: "show" });
	assert.equal(stamp(), 1000);
	assert.equal(row(database).backfill_status, "running");
	await put("a", { mode: "off" });
	assert.notEqual(stamp(), 1000, "off fences the run out");
	database.db.prepare("UPDATE mailbox_promotion_settings SET mode = 'show', backfill_status = 'failed', updated_at = 1000").run();
	await put("a", { mode: "separate" });
	assert.notEqual(stamp(), 1000, "a restart is a new job");
	assert.equal(row(database).backfill_status, "pending");
});

test("PUT answers 409 MIGRATION_REQUIRED when the table is missing", async (t) => {
	const database = await seed(t, m);
	database.db.exec("DROP TABLE mailbox_promotion_settings");
	const result = await put("a", { mode: "show" });
	assert.equal(result.status, 409);
	assert.equal(result.body.code, "MIGRATION_REQUIRED");
});

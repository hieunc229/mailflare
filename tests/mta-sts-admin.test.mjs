import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(join(root, "tests", ".tmp-mta-sts-admin-"));
after(() => rmSync(outDir, { recursive: true, force: true }));
await build({
	entryPoints: { admin: join(root, "src/lib/deliverability/mta-sts-admin.ts"), serve: join(root, "src/lib/deliverability/mta-sts-serve.ts"), daily: join(root, "src/lib/deliverability/daily.ts"), database: join(root, "server/runtime/sqlite-database.ts"), migrate: join(root, "server/runtime/migrate.ts") },
	outdir: outDir, outExtension: { ".js": ".mjs" }, bundle: true, platform: "node", format: "esm", target: "node22", tsconfig: join(root, "tsconfig.json"),
	external: ["better-sqlite3", "drizzle-orm", "drizzle-orm/*"], logLevel: "silent",
});
const load = (name) => import(pathToFileURL(join(outDir, `${name}.mjs`)).href);
const admin = await load("admin");
const { serveMtaStsPolicy } = await load("serve");
const { runDeliverabilityDaily } = await load("daily");
const { SqliteDatabase } = await load("database");
const { applyMigrations } = await load("migrate");
const NAME = "_mta-sts.example.com";
const NOW = new Date("2025-11-19T12:34:56Z");
const seconds = (date) => Math.floor(date.getTime() / 1000);

async function fixture(t, { record = null, zoneId = "zone1", mx = ["10 route1.mx.cloudflare.net.", "20 route2.mx.cloudflare.net."], failDns = false, row = null } = {}) {
	const database = new SqliteDatabase(join(outDir, `${crypto.randomUUID()}.sqlite`));
	t.after(() => database.db.close());
	await applyMigrations(database, join(root, "drizzle/migrations"));
	const now = seconds(NOW);
	database.db.prepare("INSERT INTO users (id, email, name, password_hash, created_at) VALUES ('u1', 'k@example.com', 'K', 'x', ?)").run(now);
	database.db.prepare("INSERT INTO domains (id, user_id, hostname, zone_id, created_at) VALUES ('d1', 'u1', 'example.com', ?, ?)").run(zoneId, now);
	if (row) database.db.prepare("INSERT INTO domain_deliverability (domain_id, updated_at, mta_sts_mode, mta_sts_policy_id, mta_sts_mx, mta_sts_max_age, mta_sts_retire_after) VALUES ('d1', ?, ?, ?, ?, ?, ?)").run(now, row.mode, row.policyId, row.mx ?? '["route1.mx.cloudflare.net"]', row.maxAge ?? 604800, row.retireAfter ?? null);
	const calls = [];
	const state = { record, mx };
	const records = () => (state.record === null ? [] : [].concat(state.record));
	const deps = {
		async listTxt(_env, _zone, name) { calls.push(`list ${name}`); return records().map((content, index) => ({ id: `rec${index}`, content })); },
		async queryTxt(name) { calls.push(`query ${name}`); return records(); },
		async deleteTxt(_env, _zone, id) { calls.push(`delete ${id}`); if (failDns) throw new Error("dns down"); state.record = null; },
		async createTxt(_env, _zone, name, content) { calls.push(`create ${name} ${content}`); if (failDns) throw new Error("dns down"); state.record = content; },
		async updateTxt(_env, _zone, id, content) { calls.push(`update ${id} ${content}`); if (failDns) throw new Error("dns down"); state.record = content; },
		async ensureRoute() { throw new Error("MTA-STS never touches routing"); },
		async deleteRoute() { throw new Error("MTA-STS never touches routing"); },
		async queryMx(name) { calls.push(`mx ${name}`); if (state.mx instanceof Error) throw state.mx; return state.mx; },
	};
	const domain = database.db.prepare("SELECT id, hostname, zone_id AS zoneId FROM domains WHERE id = 'd1'").get();
	const env = { DB: database };
	return { env, domain, deps, calls, state, row: () => database.db.prepare("SELECT * FROM domain_deliverability WHERE domain_id = 'd1'").get(), raw: database.db };
}
const put = (f, body, now = NOW) => admin.updateMtaSts(f.env, f.domain, body, f.deps, now);

test("publishing in testing mode reads the MX hosts, stores the policy, and creates the _mta-sts record with a new id", async (t) => {
	const f = await fixture(t);
	const result = await put(f, { mode: "testing" });
	assert.equal(result.kind, "ok");
	const row = f.row();
	assert.deepEqual([row.mta_sts_mode, row.mta_sts_policy_id, row.mta_sts_max_age, row.mta_sts_retire_after, row.mta_sts_verified_at], ["testing", "20251119123456", 604800, null, null]);
	assert.deepEqual(JSON.parse(row.mta_sts_mx), ["route1.mx.cloudflare.net", "route2.mx.cloudflare.net"]);
	assert.deepEqual(f.calls, ["mx example.com", `list ${NAME}`, `create ${NAME} v=STSv1; id=20251119123456`]);
	assert.equal(result.state.mode, "testing");
	assert.equal(result.state.status, "testing");
	assert.deepEqual(result.state.unverifiedMx, []);
	assert.equal(result.state.policy, "version: STSv1\r\nmode: testing\r\nmx: route1.mx.cloudflare.net\r\nmx: route2.mx.cloudflare.net\r\nmax_age: 604800\r\n");
	// and the route now serves exactly that policy
	const served = await serveMtaStsPolicy(f.env, new Request("https://mta-sts.example.com/.well-known/mta-sts.txt"));
	assert.equal(await served.text(), result.state.policy);
});

test("DNS announces the new id first and the policy row follows, so no sender can cache a new mode under an old id", async (t) => {
	const f = await fixture(t);
	await put(f, { mode: "testing" });
	const before = f.row();
	let rowWhenDnsWritten = null;
	f.deps.updateTxt = async (_env, _zone, _id, content) => { rowWhenDnsWritten = f.row(); f.state.record = content; };
	await put(f, { mode: "testing", maxAge: 86400 }, new Date("2025-11-19T15:00:00Z"));
	assert.equal(rowWhenDnsWritten.mta_sts_policy_id, before.mta_sts_policy_id, "the old policy is still what is served while the TXT changes");
	assert.equal(rowWhenDnsWritten.mta_sts_max_age, before.mta_sts_max_age);
	assert.equal(f.row().mta_sts_policy_id, "20251119150000");
});

test("it refuses when the domain has no MX hosts, when the lookup fails, and warns about hosts it cannot vouch for", async (t) => {
	const none = await fixture(t, { mx: ["0 ."] });
	assert.deepEqual(await put(none, { mode: "testing" }).then((r) => [r.status, r.code]), [409, "NO_MX"]);
	assert.equal(none.row(), undefined);
	const failing = await fixture(t, { mx: new Error("doh down") });
	assert.deepEqual(await put(failing, { mode: "testing" }).then((r) => [r.status, r.code]), [502, "DNS_FAILED"]);
	const own = await fixture(t, { mx: ["10 mail.selfhosted.test.", "20 inbound-smtp.us-east-1.amazonaws.com."] });
	const result = await put(own, { mode: "testing" });
	assert.deepEqual(result.state.unverifiedMx, ["mail.selfhosted.test"]);
	const many = await fixture(t, { mx: Array.from({ length: 21 }, (_, index) => `10 mx${index}.example.net.`) });
	assert.deepEqual(await put(many, { mode: "testing" }).then((r) => [r.status, r.code]), [409, "TOO_MANY_MX"]);
});

test("an MX host that is not a plain host name refuses the publish instead of being left out of the policy", async (t) => {
	const f = await fixture(t, { mx: ["10 mx1.example.net.", "20 bad_host.example.net.", "30 mx3.example.net."] });
	const result = await put(f, { mode: "testing" });
	assert.deepEqual([result.status, result.code], [409, "INVALID_MX"]);
	assert.match(result.message, /bad_host\.example\.net/);
	assert.equal(f.row(), undefined);
	assert.deepEqual(f.calls, ["mx example.com"], "nothing was written");
	const garbled = await fixture(t, { mx: ["not an mx answer"] });
	assert.deepEqual(await put(garbled, { mode: "testing" }).then((r) => [r.status, r.code]), [409, "INVALID_MX"]);
});

test("a record at _mta-sts that is not ours blocks publishing, and nothing is stored", async (t) => {
	const foreign = await fixture(t, { record: "v=STSv1; id=handmade1" });
	assert.deepEqual(await put(foreign, { mode: "testing" }).then((r) => [r.status, r.code]), [409, "MTA_STS_RECORD_EXISTS"]);
	assert.equal(foreign.row(), undefined);
	assert.equal(foreign.state.record, "v=STSv1; id=handmade1");
	const many = await fixture(t, { record: ["v=STSv1; id=a", "v=STSv1; id=b"] });
	assert.deepEqual(await put(many, { mode: "testing" }).then((r) => [r.status, r.code]), [409, "MULTIPLE_MTA_STS_RECORDS"]);
});

test("the id changes when mode, MX list or max_age change, and only then", async (t) => {
	const f = await fixture(t);
	await put(f, { mode: "testing" });
	const first = f.row().mta_sts_policy_id;
	f.calls.length = 0;
	const same = await put(f, { mode: "testing" }, new Date("2025-11-19T13:00:00Z"));
	assert.equal(f.row().mta_sts_policy_id, first);
	assert.deepEqual(f.calls, ["mx example.com", `list ${NAME}`], "no DNS write when nothing changed");
	assert.equal(same.kind, "ok");
	await put(f, { mode: "testing", maxAge: 86400 }, new Date("2025-11-19T13:00:00Z"));
	const second = f.row().mta_sts_policy_id;
	assert.equal(second, "20251119130000");
	f.state.mx = ["10 route1.mx.cloudflare.net."];
	await put(f, { mode: "testing", maxAge: 86400 }, new Date("2025-11-19T14:00:00Z"));
	assert.equal(f.row().mta_sts_policy_id, "20251119140000");
	assert.equal(f.state.record, "v=STSv1; id=20251119140000");
	await put(f, { mode: "testing", maxAge: 86400 }, new Date("2025-11-19T14:00:00Z"));
	assert.equal(f.row().mta_sts_policy_id, "20251119140000", "unchanged again");
});

test("enforce needs testing first and an explicit acknowledgement that every MX host presents a valid certificate", async (t) => {
	const f = await fixture(t);
	assert.deepEqual(await put(f, { mode: "enforce", acknowledgeRisk: true }).then((r) => [r.status, r.code]), [409, "TESTING_FIRST"]);
	await put(f, { mode: "testing" });
	assert.deepEqual(await put(f, { mode: "enforce" }).then((r) => [r.status, r.code]), [409, "ACKNOWLEDGE_REQUIRED"]);
	assert.deepEqual(await put(f, { mode: "enforce", acknowledgeRisk: "yes" }).then((r) => [r.status, r.code]), [409, "ACKNOWLEDGE_REQUIRED"]);
	assert.equal(f.row().mta_sts_mode, "testing");
	const result = await put(f, { mode: "enforce", acknowledgeRisk: true }, new Date("2025-11-19T13:00:00Z"));
	assert.equal(result.kind, "ok");
	assert.equal(f.row().mta_sts_mode, "enforce");
	assert.equal(f.row().mta_sts_policy_id, "20251119130000");
	assert.match(result.state.policy, /mode: enforce/);
	// going back to testing needs no acknowledgement
	assert.equal((await put(f, { mode: "testing" }, new Date("2025-11-19T14:00:00Z"))).kind, "ok");
	assert.equal(f.row().mta_sts_mode, "testing");
});

test("turning it off starts the removal: mode none is served with a new id until now + max_age", async (t) => {
	const f = await fixture(t);
	await put(f, { mode: "testing", maxAge: 86400 });
	const off = new Date("2025-11-20T00:00:00Z");
	const result = await put(f, { mode: "none" }, off);
	assert.equal(result.kind, "ok");
	const row = f.row();
	assert.deepEqual([row.mta_sts_mode, row.mta_sts_policy_id, row.mta_sts_retire_after], ["none", "20251120000000", seconds(off) + 86400]);
	assert.equal(f.state.record, "v=STSv1; id=20251120000000", "the TXT stays, with a new id");
	assert.equal(result.state.status, "retiring");
	assert.equal(result.state.retireAfter, new Date((seconds(off) + 86400) * 1000).toISOString());
	const served = await serveMtaStsPolicy(f.env, new Request("https://mta-sts.example.com/.well-known/mta-sts.txt"));
	assert.match(await served.text(), /^version: STSv1\r\nmode: none\r\n/);
	// off again changes nothing, and so does off when nothing was ever published
	const again = await put(f, { mode: "none" }, new Date("2025-11-20T01:00:00Z"));
	assert.equal(f.row().mta_sts_retire_after, seconds(off) + 86400);
	assert.equal(again.kind, "ok");
	const never = await fixture(t);
	assert.equal((await put(never, { mode: "none" })).kind, "ok");
	assert.equal(never.row(), undefined);
});

test("publishing again during the removal period works and cancels the retirement", async (t) => {
	const f = await fixture(t);
	await put(f, { mode: "testing" });
	await put(f, { mode: "none" }, new Date("2025-11-20T00:00:00Z"));
	const result = await put(f, { mode: "testing" }, new Date("2025-11-20T01:00:00Z"));
	assert.equal(result.kind, "ok");
	assert.deepEqual([f.row().mta_sts_mode, f.row().mta_sts_retire_after], ["testing", null]);
});

test("max_age must be a whole number of seconds from one day to one year", async (t) => {
	const f = await fixture(t);
	for (const maxAge of [0, 86399, 31_557_601, 1.5, "604800", null]) assert.deepEqual(await put(f, { mode: "testing", maxAge }).then((r) => [r.status, r.code]), [400, "INVALID_MAX_AGE"], String(maxAge));
	assert.equal(f.row(), undefined);
	for (const body of [null, {}, { mode: "bogus" }, { mode: 1 }, [], "x"]) assert.deepEqual(await put(f, body).then((r) => [r.status, r.code]), [400, "INVALID_BODY"]);
});

test("a failing DNS write never touches the stored policy and reports the error", async (t) => {
	const f = await fixture(t);
	await put(f, { mode: "testing" });
	const before = f.row();
	f.deps.updateTxt = async () => { throw new Error("dns down"); };
	const result = await put(f, { mode: "testing", maxAge: 86400 }, new Date("2025-11-19T15:00:00Z"));
	assert.deepEqual([result.status, result.code], [502, "DNS_FAILED"]);
	const after = f.row();
	for (const key of ["mta_sts_mode", "mta_sts_policy_id", "mta_sts_mx", "mta_sts_max_age", "mta_sts_retire_after"]) assert.equal(after[key], before[key], key);
	const fresh = await fixture(t, { failDns: true });
	assert.deepEqual(await put(fresh, { mode: "testing" }).then((r) => [r.status, r.code]), [502, "DNS_FAILED"]);
	assert.equal(fresh.row(), undefined, "a first publish that failed is not left serving a policy");
});

test("a manual zone is not edited: the policy is served and the TXT value is returned to publish", async (t) => {
	const f = await fixture(t, { zoneId: "manual" });
	const result = await put(f, { mode: "testing" });
	assert.equal(result.kind, "ok");
	assert.deepEqual(result.state.txt, { name: NAME, content: "v=STSv1; id=20251119123456", manual: true });
	assert.deepEqual(f.calls, ["mx example.com", `query ${NAME}`]);
	assert.equal(f.row().mta_sts_policy_id, "20251119123456");
});

test("recording the browser check needs a published policy", async (t) => {
	const f = await fixture(t);
	assert.deepEqual(await admin.markMtaStsVerified(f.env, f.domain, NOW).then((r) => [r.status, r.code]), [409, "NOT_PUBLISHED"]);
	await put(f, { mode: "testing" });
	const result = await admin.markMtaStsVerified(f.env, f.domain, NOW);
	assert.equal(result.kind, "ok");
	assert.equal(f.row().mta_sts_verified_at, seconds(NOW));
	await put(f, { mode: "testing", maxAge: 86400 });
	assert.equal(f.row().mta_sts_verified_at, null, "a changed policy has to be checked again");
});

test("the daily job removes the record and clears the policy once the removal period is over, not before", async (t) => {
	const f = await fixture(t, { record: "v=STSv1; id=20251119000000", row: { mode: "none", policyId: "20251119000000", retireAfter: seconds(NOW) + 3600 } });
	await runDeliverabilityDaily(f.env, NOW, { sendMail: async () => true, mtaStsDeps: f.deps });
	assert.equal(f.row().mta_sts_policy_id, "20251119000000");
	assert.equal(f.state.record, "v=STSv1; id=20251119000000");
	f.raw.prepare("UPDATE domain_deliverability SET mta_sts_retire_after = ?").run(seconds(NOW) - 1);
	await runDeliverabilityDaily(f.env, NOW, { sendMail: async () => true, mtaStsDeps: f.deps });
	assert.equal(f.state.record, null);
	const row = f.row();
	assert.deepEqual([row.mta_sts_mode, row.mta_sts_policy_id, row.mta_sts_mx, row.mta_sts_retire_after, row.mta_sts_verified_at], ["none", null, null, null, null]);
	assert.equal((await serveMtaStsPolicy(f.env, new Request("https://mta-sts.example.com/.well-known/mta-sts.txt"))).status, 404);
	assert.ok(f.calls.includes("delete rec0"));
});

test("a failing record delete leaves the policy served and is tried again the next day; a testing or enforce policy is never retired", async (t) => {
	const f = await fixture(t, { record: "v=STSv1; id=20251119000000", failDns: true, row: { mode: "none", policyId: "20251119000000", retireAfter: seconds(NOW) - 1 } });
	const error = console.error;
	console.error = () => {};
	t.after(() => { console.error = error; });
	await runDeliverabilityDaily(f.env, NOW, { sendMail: async () => true, mtaStsDeps: f.deps });
	assert.equal(f.row().mta_sts_policy_id, "20251119000000");
	const live = await fixture(t, { record: "v=STSv1; id=20251119000000", row: { mode: "testing", policyId: "20251119000000", retireAfter: seconds(NOW) - 1 } });
	await runDeliverabilityDaily(live.env, NOW, { sendMail: async () => true, mtaStsDeps: live.deps });
	assert.equal(live.row().mta_sts_policy_id, "20251119000000");
	assert.equal(live.state.record, "v=STSv1; id=20251119000000");
});

test("a manual zone's policy is cleared without touching DNS when its removal period ends", async (t) => {
	const f = await fixture(t, { zoneId: "manual", record: "v=STSv1; id=20251119000000", row: { mode: "none", policyId: "20251119000000", retireAfter: seconds(NOW) - 1 } });
	await runDeliverabilityDaily(f.env, NOW, { sendMail: async () => true, mtaStsDeps: f.deps });
	assert.equal(f.row().mta_sts_policy_id, null);
	assert.deepEqual(f.calls.filter((call) => call.startsWith("delete")), []);
});

test("while enforce is published the MX list cannot change: back to testing first", async (t) => {
	const f = await fixture(t);
	await put(f, { mode: "testing" });
	await put(f, { mode: "enforce", acknowledgeRisk: true }, new Date("2025-11-19T13:00:00Z"));
	const id = f.row().mta_sts_policy_id;
	f.state.mx = ["10 route1.mx.cloudflare.net.", "20 other.example.net."];
	const refused = await put(f, { mode: "enforce", acknowledgeRisk: true }, new Date("2025-11-19T14:00:00Z"));
	assert.deepEqual([refused.status, refused.code], [409, "MX_CHANGED_IN_ENFORCE"]);
	assert.equal(f.row().mta_sts_policy_id, id);
	assert.equal(JSON.parse(f.row().mta_sts_mx).length, 2);
	// testing republishes the new list under a new id; enforce can follow once the list was watched in testing
	assert.equal((await put(f, { mode: "testing" }, new Date("2025-11-19T15:00:00Z"))).kind, "ok");
	assert.deepEqual(JSON.parse(f.row().mta_sts_mx), ["other.example.net", "route1.mx.cloudflare.net"]);
	assert.equal((await put(f, { mode: "enforce", acknowledgeRisk: true }, new Date("2025-11-19T16:00:00Z"))).kind, "ok");
});

test("switching testing to enforce is refused while the live MX list differs from the one that was watched", async (t) => {
	const f = await fixture(t);
	await put(f, { mode: "testing" });
	f.state.mx = ["10 other.example.net."];
	assert.deepEqual(await put(f, { mode: "enforce", acknowledgeRisk: true }, new Date("2025-11-19T13:00:00Z")).then((r) => [r.status, r.code]), [409, "MX_CHANGED_IN_ENFORCE"]);
	assert.equal(f.row().mta_sts_mode, "testing");
});

test("the removal period waits the longest max_age served, not only the current one", async (t) => {
	const f = await fixture(t);
	await put(f, { mode: "testing", maxAge: 31_557_600 });
	await put(f, { mode: "testing", maxAge: 86_400 }, new Date("2025-11-19T13:00:00Z"));
	assert.equal(f.row().mta_sts_served_max_age, 31_557_600);
	const off = new Date("2025-11-20T00:00:00Z");
	await put(f, { mode: "none" }, off);
	assert.equal(f.row().mta_sts_retire_after, seconds(off) + 31_557_600, "a sender may still hold the year-long policy");
	// once retired the next policy starts its own history
	f.raw.prepare("UPDATE domain_deliverability SET mta_sts_retire_after = ?").run(seconds(NOW) - 1);
	await admin.retireMtaSts(f.env, NOW, f.deps);
	assert.equal(f.row().mta_sts_served_max_age, null);
	await put(f, { mode: "testing", maxAge: 86_400 }, new Date("2025-12-01T00:00:00Z"));
	assert.equal(f.row().mta_sts_served_max_age, 86_400);
	await put(f, { mode: "none" }, off);
	assert.equal(f.row().mta_sts_retire_after, seconds(off) + 86_400);
});

test("the state compares the live MX records with the stored list", async (t) => {
	const f = await fixture(t);
	await put(f, { mode: "testing" });
	const same = await admin.mxDrift(f.domain, (await admin.getMtaStsState(f.env, f.domain)), f.deps);
	assert.deepEqual(same, { liveMx: ["route1.mx.cloudflare.net", "route2.mx.cloudflare.net"], differs: false });
	f.state.mx = ["10 route1.mx.cloudflare.net.", "20 new.example.net."];
	const drift = await admin.mxDrift(f.domain, (await admin.getMtaStsState(f.env, f.domain)), f.deps);
	assert.equal(drift.differs, true);
	assert.deepEqual(drift.liveMx, ["new.example.net", "route1.mx.cloudflare.net"]);
	f.state.mx = ["10 route1.mx.cloudflare.net.", "20 bad_host.example.net."];
	assert.equal((await admin.mxDrift(f.domain, (await admin.getMtaStsState(f.env, f.domain)), f.deps)).differs, true, "an invalid live host is a difference too");
	f.state.mx = new Error("doh down");
	assert.deepEqual(await admin.mxDrift(f.domain, (await admin.getMtaStsState(f.env, f.domain)), f.deps), { error: true });
});

const gone = (status) => Object.assign(new Error("zone unavailable"), { name: "CloudflareApiError", status });

test("a zone Cloudflare no longer serves (404, 403) is treated like a manual zone: MTA-STS can be turned off and the daily job still retires it", async (t) => {
	for (const status of [404, 403]) {
		const f = await fixture(t, { record: "v=STSv1; id=20251119000000", row: { mode: "testing", policyId: "20251119000000" } });
		f.deps.listTxt = async () => { throw gone(status); };
		const off = await put(f, { mode: "none" });
		assert.equal(off.kind, "ok", String(status));
		assert.equal(off.state.txt.manual, true);
		assert.equal(f.row().mta_sts_mode, "none");
		f.raw.prepare("UPDATE domain_deliverability SET mta_sts_retire_after = ?").run(seconds(NOW) - 1);
		await runDeliverabilityDaily(f.env, NOW, { sendMail: async () => true, mtaStsDeps: f.deps });
		assert.equal(f.row().mta_sts_policy_id, null, `retired with ${status}`);
	}
	const error = console.error;
	console.error = () => {};
	t.after(() => { console.error = error; });
	const broken = await fixture(t, { record: "v=STSv1; id=20251119000000", row: { mode: "testing", policyId: "20251119000000" } });
	broken.deps.listTxt = async () => { throw gone(500); };
	assert.equal((await put(broken, { mode: "none" })).kind, "error");
	assert.equal(broken.row().mta_sts_mode, "testing");
});

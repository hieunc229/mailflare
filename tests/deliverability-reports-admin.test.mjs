import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(join(root, "tests", ".tmp-reports-admin-"));
after(() => rmSync(outDir, { recursive: true, force: true }));

await build({
	entryPoints: {
		admin: join(root, "src/lib/deliverability/reports-admin.ts"),
		database: join(root, "server/runtime/sqlite-database.ts"),
		migrate: join(root, "server/runtime/migrate.ts"),
	},
	outdir: outDir,
	outExtension: { ".js": ".mjs" },
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node22",
	tsconfig: join(root, "tsconfig.json"),
	external: ["better-sqlite3", "drizzle-orm", "drizzle-orm/*"],
	logLevel: "silent",
});
const load = (name) => import(pathToFileURL(join(outDir, `${name}.mjs`)).href);
const admin = await load("admin");
const { SqliteDatabase } = await load("database");
const { applyMigrations } = await load("migrate");
const seconds = (date) => Math.floor(date.getTime() / 1000);
const ADDRESS = "mailflare-reports@example.com";

/** What the dialog does: preview, then confirm with the previewed record. An error at the preview is the result. */
async function apply(f, enabled, { tamper } = {}) {
	const preview = await admin.updateReports(f.env, f.domain, { enabled }, f.deps);
	if (preview.kind !== "preview") return preview;
	f.calls.length = 0;
	const previewed = { before: preview.plan.before, after: preview.plan.after, ...tamper };
	return admin.updateReports(f.env, f.domain, { enabled, confirm: true, previewed }, f.deps);
}

async function fixture(t, { record = null, zoneId = "zone1", receivingProvider = "cloudflare", mailbox = null, failDns = false, failRoute = false, hostname = "example.com", parents = {}, createdRecord = null } = {}) {
	const database = new SqliteDatabase(join(outDir, `${crypto.randomUUID()}.sqlite`));
	t.after(() => database.db.close());
	await applyMigrations(database, join(root, "drizzle/migrations"));
	const now = seconds(new Date());
	database.db.prepare("INSERT INTO users (id, email, name, password_hash, created_at) VALUES ('u1', 'kevin@example.com', 'Kevin', 'x', ?)").run(now);
	database.db.prepare("INSERT INTO domains (id, user_id, hostname, zone_id, receiving_provider, created_at) VALUES ('d1', 'u1', ?, ?, ?, ?)").run(hostname, zoneId, receivingProvider, now);
	if (createdRecord) database.db.prepare("INSERT INTO domain_deliverability (domain_id, reports_enabled, dmarc_created_record, updated_at) VALUES ('d1', 1, ?, ?)").run(createdRecord, now);
	if (mailbox) database.db.prepare("INSERT INTO mailboxes (id, user_id, domain_id, local_part, created_at) VALUES ('mb1', 'u1', 'd1', ?, ?)").run(mailbox, now);
	const calls = [];
	let current = record;
	const deps = {
		async listTxt() { calls.push("list"); return current === null ? [] : (Array.isArray(current) ? current : [current]).map((content, index) => ({ id: `rec${index}`, content })); },
		async queryTxt(name) {
			calls.push(`query ${name}`);
			if (name in parents) { if (parents[name] instanceof Error) throw parents[name]; return [].concat(parents[name]); }
			return current === null ? [] : [].concat(current);
		},
		async deleteTxt(_env, _zone, id) { calls.push(`delete ${id}`); if (failDns) throw new Error("dns down"); current = null; },
		async createTxt(_env, _zone, name, content) { calls.push(`create ${name} ${content}`); if (failDns) throw new Error("dns down"); current = content; },
		async updateTxt(_env, _zone, id, content) { calls.push(`update ${id} ${content}`); if (failDns) throw new Error("dns down"); current = content; },
		async ensureRoute(_env, zone, address) { calls.push(`route+ ${zone} ${address}`); if (failRoute) throw new Error("routing down"); },
		async deleteRoute(_env, zone, address) { calls.push(`route- ${zone} ${address}`); return true; },
	};
	const domain = database.db.prepare("SELECT id, hostname, zone_id AS zoneId, receiving_provider AS receivingProvider FROM domains WHERE id = 'd1'").get();
	const address = `mailflare-reports@${hostname}`;
	const env = { DB: database };
	const row = () => database.db.prepare("SELECT * FROM domain_deliverability WHERE domain_id = 'd1'").get();
	return { env, domain, deps, calls, row, address, current: () => current, raw: database.db };
}

test("turning reports on without confirm only previews: no write, no DNS, no routing rule", async (t) => {
	const f = await fixture(t, { record: "v=DMARC1; p=none" });
	const result = await admin.updateReports(f.env, f.domain, { enabled: true }, f.deps);
	assert.equal(result.kind, "preview");
	assert.deepEqual(result.plan, { address: ADDRESS, before: "v=DMARC1; p=none", after: `v=DMARC1; p=none; rua=mailto:${ADDRESS}`, changed: true, manual: false });
	assert.deepEqual(f.calls, ["list"]);
	assert.equal(f.row(), undefined);
});

test("confirming without the previewed record, or after the record changed, applies nothing", async (t) => {
	const f = await fixture(t, { record: "v=DMARC1; p=none" });
	const missing = await admin.updateReports(f.env, f.domain, { enabled: true, confirm: true }, f.deps);
	assert.deepEqual([missing.kind, missing.status, missing.code], ["error", 400, "INVALID_BODY"]);
	for (const previewed of ["x", { before: 1, after: null }, { before: null }]) assert.equal((await admin.updateReports(f.env, f.domain, { enabled: true, confirm: true, previewed }, f.deps)).status, 400);
	// Someone edited _dmarc between the preview and the click.
	const stale = await apply(f, true, { tamper: { before: "v=DMARC1; p=reject" } });
	assert.deepEqual([stale.kind, stale.status, stale.code], ["error", 409, "DMARC_CHANGED"]);
	const staleAfter = await apply(f, true, { tamper: { after: "v=DMARC1; p=none; rua=mailto:attacker@evil.example" } });
	assert.equal(staleAfter.code, "DMARC_CHANGED");
	assert.ok(!f.calls.some((call) => call.startsWith("update") || call.startsWith("create") || call.startsWith("route")), JSON.stringify(f.calls));
	assert.equal(f.row(), undefined);
});

test("confirming creates the routing rule, edits _dmarc in place and turns the switch on", async (t) => {
	const f = await fixture(t, { record: "v=DMARC1; p=quarantine; pct=50" });
	const result = await apply(f, true);
	assert.equal(result.kind, "ok");
	assert.deepEqual(f.calls, ["list", `route+ zone1 ${ADDRESS}`, `update rec0 v=DMARC1; p=quarantine; pct=50; rua=mailto:${ADDRESS}`]);
	assert.equal(f.row().reports_enabled, 1);
	assert.ok(f.row().reports_enabled_at > 0);
	assert.equal(result.state.enabled, true);
	assert.equal(result.state.address, ADDRESS);
});

test("with no _dmarc record one is created with a rua", async (t) => {
	const f = await fixture(t);
	await apply(f, true);
	assert.ok(f.calls.includes(`create _dmarc.example.com v=DMARC1; p=none; rua=mailto:${ADDRESS}`));
});

test("a record that already carries our address needs no DNS change", async (t) => {
	const f = await fixture(t, { record: `v=DMARC1; p=none; rua=mailto:${ADDRESS}` });
	const preview = await admin.updateReports(f.env, f.domain, { enabled: true }, f.deps);
	assert.equal(preview.plan.changed, false);
	await apply(f, true);
	assert.ok(!f.calls.some((call) => call.startsWith("update") || call.startsWith("create")));
	assert.equal(f.row().reports_enabled, 1);
});

test("a failed DNS edit leaves reporting off and reports the error", async (t) => {
	const f = await fixture(t, { record: "v=DMARC1; p=none", failDns: true });
	const result = await apply(f, true);
	assert.equal(result.kind, "error");
	assert.equal(result.status, 502);
	assert.equal(result.code, "DNS_FAILED");
	assert.equal(f.row(), undefined);
});

test("when the DNS edit fails after the routing rule was created, the rule is removed again", async (t) => {
	const f = await fixture(t, { record: "v=DMARC1; p=none", failDns: true });
	await apply(f, true);
	assert.deepEqual(f.calls.filter((call) => call.startsWith("route")), [`route+ zone1 ${ADDRESS}`, `route- zone1 ${ADDRESS}`]);
	assert.equal(f.row(), undefined);
});

test("a failed routing rule stops before DNS is touched", async (t) => {
	const f = await fixture(t, { record: "v=DMARC1; p=none", failRoute: true });
	const result = await apply(f, true);
	assert.equal(result.code, "ROUTING_FAILED");
	assert.ok(!f.calls.some((call) => call.startsWith("update")));
	assert.equal(f.row(), undefined);
});

test("two DMARC records at the name are refused, not guessed at", async (t) => {
	const f = await fixture(t, { record: ["v=DMARC1; p=none", "v=DMARC1; p=reject"] });
	const result = await apply(f, true);
	assert.equal(result.kind, "error");
	assert.equal(result.code, "MULTIPLE_DMARC_RECORDS");
	assert.equal(f.row(), undefined);
});

test("a TXT record that is not DMARC at _dmarc is ignored for matching; a lookalike is not edited", async (t) => {
	const f = await fixture(t, { record: "v=spf1 -all" });
	const result = await admin.updateReports(f.env, f.domain, { enabled: true }, f.deps);
	assert.equal(result.plan.before, null);
	assert.equal(result.plan.after, `v=DMARC1; p=none; rua=mailto:${ADDRESS}`);
});

test("a mailbox or alias already using the local part blocks the address", async (t) => {
	const f = await fixture(t, { mailbox: "mailflare-reports" });
	const result = await apply(f, true);
	assert.deepEqual([result.kind, result.status, result.code], ["error", 409, "ADDRESS_TAKEN"]);
	const g = await fixture(t, { mailbox: "kevin" });
	g.raw.prepare("INSERT INTO mailbox_aliases (id, mailbox_id, domain_id, local_part, created_at) VALUES ('a1', 'mb1', 'd1', 'MailFlare-Reports', ?)").run(seconds(new Date()));
	assert.equal((await admin.updateReports(g.env, g.domain, { enabled: true }, g.deps)).code, "ADDRESS_TAKEN");
});

test("a domain that does not receive mail cannot receive reports", async (t) => {
	const f = await fixture(t, { receivingProvider: "none" });
	assert.equal((await admin.updateReports(f.env, f.domain, { enabled: true }, f.deps)).code, "RECEIVING_REQUIRED");
});

test("a manual zone reads DNS over DoH, edits nothing and returns the value to paste", async (t) => {
	const f = await fixture(t, { zoneId: "manual", record: "v=DMARC1; p=none" });
	const preview = await admin.updateReports(f.env, f.domain, { enabled: true }, f.deps);
	assert.equal(preview.plan.manual, true);
	assert.equal(preview.plan.after, `v=DMARC1; p=none; rua=mailto:${ADDRESS}`);
	const done = await apply(f, true);
	assert.equal(done.kind, "ok");
	assert.deepEqual(f.calls.filter((call) => !call.startsWith("query")), []);
	assert.equal(f.row().reports_enabled, 1);
});

test("receiving through Resend or SES needs no routing rule", async (t) => {
	const f = await fixture(t, { record: "v=DMARC1; p=none", receivingProvider: "ses" });
	await apply(f, true);
	assert.ok(!f.calls.some((call) => call.startsWith("route")));
	assert.equal(f.row().reports_enabled, 1);
});

test("turning off removes only our uri, deletes the routing rule and keeps stored data", async (t) => {
	const f = await fixture(t, { record: `v=DMARC1; p=none; rua=mailto:a@x.org,mailto:${ADDRESS}` });
	await apply(f, true);
	f.raw.prepare("INSERT INTO deliverability_reports (id, domain_id, report_key, status, received_at) VALUES ('r1', 'd1', 'k', 'ok', ?)").run(seconds(new Date()));
	f.calls.length = 0;
	const preview = await admin.updateReports(f.env, f.domain, { enabled: false }, f.deps);
	assert.equal(preview.plan.after, "v=DMARC1; p=none; rua=mailto:a@x.org");
	const result = await apply(f, false);
	assert.equal(result.kind, "ok");
	assert.ok(f.calls.includes("update rec0 v=DMARC1; p=none; rua=mailto:a@x.org"));
	assert.ok(f.calls.includes(`route- zone1 ${ADDRESS}`));
	assert.equal(f.row().reports_enabled, 0);
	assert.equal(f.raw.prepare("SELECT count(*) AS n FROM deliverability_reports").get().n, 1);
});

const PARENT = "_dmarc.example.com";
const SUB = "mailflare-reports@sub.example.com";

test("a new _dmarc record for a subdomain copies the organisation's effective policy (sp, else p)", async (t) => {
	const f = await fixture(t, { hostname: "sub.example.com", parents: { [PARENT]: ["v=spf1 -all", "v=DMARC1; p=reject; sp=quarantine; adkim=s; aspf=r; pct=50; rua=mailto:boss@example.com; fo=1"] } });
	const preview = await admin.updateReports(f.env, f.domain, { enabled: true }, f.deps);
	assert.equal(preview.plan.before, null);
	assert.equal(preview.plan.after, `v=DMARC1; p=quarantine; adkim=s; aspf=r; pct=50; rua=mailto:${SUB}`);
	assert.deepEqual(f.calls, ["list", `query ${PARENT}`]);
	await apply(f, true);
	assert.ok(f.calls.includes(`create _dmarc.sub.example.com v=DMARC1; p=quarantine; adkim=s; aspf=r; pct=50; rua=mailto:${SUB}`));
	const g = await fixture(t, { hostname: "sub.example.com", parents: { [PARENT]: "v=DMARC1; p=reject" } });
	assert.equal((await admin.updateReports(g.env, g.domain, { enabled: true }, g.deps)).plan.after, `v=DMARC1; p=reject; rua=mailto:${SUB}`, "no sp: p is the subdomain policy");
});

test("a subdomain under a private public suffix inherits from its own organisation, not the suffix", async (t) => {
	const f = await fixture(t, { hostname: "sub.example.eu.org", parents: { "_dmarc.example.eu.org": "v=DMARC1; p=reject; sp=quarantine" } });
	const preview = await admin.updateReports(f.env, f.domain, { enabled: true }, f.deps);
	assert.equal(preview.plan.after, "v=DMARC1; p=quarantine; rua=mailto:mailflare-reports@sub.example.eu.org");
	assert.deepEqual(f.calls, ["list", "query _dmarc.example.eu.org"]);
});

test("a subdomain with no organisation record, an unusable one or the organisation domain itself gets p=none", async (t) => {
	const none = await fixture(t, { hostname: "sub.example.com" });
	assert.equal((await admin.updateReports(none.env, none.domain, { enabled: true }, none.deps)).plan.after, `v=DMARC1; p=none; rua=mailto:${SUB}`);
	const odd = await fixture(t, { hostname: "sub.example.com", parents: { [PARENT]: "v=DMARC1; p=bogus; sp=nonsense; pct=abc; adkim=x" } });
	assert.equal((await admin.updateReports(odd.env, odd.domain, { enabled: true }, odd.deps)).plan.after, `v=DMARC1; p=none; rua=mailto:${SUB}`);
	const two = await fixture(t, { hostname: "sub.example.com", parents: { [PARENT]: ["v=DMARC1; p=reject", "v=DMARC1; p=none"] } });
	assert.equal((await admin.updateReports(two.env, two.domain, { enabled: true }, two.deps)).plan.after, `v=DMARC1; p=none; rua=mailto:${SUB}`, "two parent records are not a policy");
	const org = await fixture(t, { parents: { [PARENT]: "v=DMARC1; p=reject" } });
	assert.equal((await admin.updateReports(org.env, org.domain, { enabled: true }, org.deps)).plan.after, `v=DMARC1; p=none; rua=mailto:${ADDRESS}`);
	assert.ok(!org.calls.some((call) => call.startsWith("query")), "the organisation domain has no parent to ask");
	const failing = await fixture(t, { hostname: "sub.example.com", parents: { [PARENT]: new Error("doh down") } });
	const result = await admin.updateReports(failing.env, failing.domain, { enabled: true }, failing.deps);
	assert.deepEqual([result.kind, result.status, result.code], ["error", 502, "DNS_FAILED"]);
});

test("turning off removes the _dmarc record when we created it and it is unchanged, and forgets it", async (t) => {
	const f = await fixture(t);
	await apply(f, true);
	const created = `v=DMARC1; p=none; rua=mailto:${ADDRESS}`;
	assert.equal(f.row().dmarc_created_record, created);
	const preview = await admin.updateReports(f.env, f.domain, { enabled: false }, f.deps);
	assert.deepEqual(preview.plan, { address: ADDRESS, before: created, after: null, changed: true, manual: false });
	f.calls.length = 0;
	const result = await apply(f, false);
	assert.equal(result.kind, "ok");
	assert.deepEqual(f.calls, ["list", "delete rec0", `route- zone1 ${ADDRESS}`]);
	assert.equal(f.current(), null);
	assert.deepEqual([f.row().reports_enabled, f.row().dmarc_created_record], [0, null]);
});

test("turning off only strips our address when the record was edited since we created it, or was not ours", async (t) => {
	const f = await fixture(t);
	await apply(f, true);
	f.deps.updateTxt(null, null, "rec0", `v=DMARC1; p=reject; rua=mailto:${ADDRESS}`);
	f.calls.length = 0;
	await apply(f, false);
	assert.ok(f.calls.includes("update rec0 v=DMARC1; p=reject"), JSON.stringify(f.calls));
	assert.ok(!f.calls.some((call) => call.startsWith("delete")));
	assert.equal(f.row().dmarc_created_record, null);
	const g = await fixture(t, { record: "v=DMARC1; p=none" });
	await apply(g, true);
	assert.equal(g.row().dmarc_created_record, null, "an existing record is edited, never remembered as ours");
	await apply(g, false);
	assert.ok(g.calls.includes("update rec0 v=DMARC1; p=none"));
});

test("alertEmail toggles on its own with no DNS and no confirm", async (t) => {
	const f = await fixture(t);
	const result = await admin.updateReports(f.env, f.domain, { alertEmail: true }, f.deps);
	assert.equal(result.kind, "ok");
	assert.equal(f.row().alert_email, 1);
	assert.equal(f.row().reports_enabled, 0);
	assert.deepEqual(f.calls, []);
});

test("getReportState defaults to off without a row", async (t) => {
	const f = await fixture(t);
	assert.deepEqual(await admin.getReportState(f.env, f.domain), { address: ADDRESS, enabled: false, alertEmail: false, enabledAt: null, lastReportAt: null });
});

test("a body that is not an object of booleans is rejected", async (t) => {
	const f = await fixture(t);
	for (const body of [null, "x", { enabled: "yes" }, { alertEmail: 1 }, {}]) assert.equal((await admin.updateReports(f.env, f.domain, body, f.deps)).status, 400, JSON.stringify(body));
});

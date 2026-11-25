import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(join(root, "tests", ".tmp-mta-sts-"));
after(() => rmSync(outDir, { recursive: true, force: true }));
await build({
	entryPoints: { utils: join(root, "src/lib/deliverability/mta-sts.ts"), serve: join(root, "src/lib/deliverability/mta-sts-serve.ts"), database: join(root, "server/runtime/sqlite-database.ts"), migrate: join(root, "server/runtime/migrate.ts") },
	outdir: outDir, outExtension: { ".js": ".mjs" }, bundle: true, platform: "node", format: "esm", target: "node22", tsconfig: join(root, "tsconfig.json"),
	external: ["better-sqlite3", "drizzle-orm", "drizzle-orm/*"], logLevel: "silent",
});
const load = (name) => import(pathToFileURL(join(outDir, `${name}.mjs`)).href);
const utils = await load("utils");
const { serveMtaStsPolicy } = await load("serve");
const { SqliteDatabase } = await load("database");
const { applyMigrations } = await load("migrate");
const { buildMtaStsPolicy, mtaStsHostDomain, guardMtaStsHost, nextPolicyId, normalizeMx, parseMaxAge, MTA_STS_LIMITS } = utils;

test("the policy is CRLF lines in RFC 8461 order, with the MX hosts sorted", () => {
	assert.equal(buildMtaStsPolicy({ mode: "testing", mx: ["b.example.net", "a.example.net"], maxAge: 604800 }), "version: STSv1\r\nmode: testing\r\nmx: a.example.net\r\nmx: b.example.net\r\nmax_age: 604800\r\n");
	assert.equal(buildMtaStsPolicy({ mode: "enforce", mx: ["*.mx.cloudflare.net"], maxAge: 86400 }), "version: STSv1\r\nmode: enforce\r\nmx: *.mx.cloudflare.net\r\nmax_age: 86400\r\n");
	assert.equal(buildMtaStsPolicy({ mode: "none", mx: ["mx.example.net"], maxAge: 86400 }), "version: STSv1\r\nmode: none\r\nmx: mx.example.net\r\nmax_age: 86400\r\n");
});

test("nothing that could inject a line or a field gets into the policy", () => {
	for (const mx of ["mx.example.net\r\nmode: none", "mx example.net", "mx.example.net;", "", "-bad.example.net", "a..b", "*", "*.", "mx.*.example", "http://x.test", "x".repeat(254)]) {
		assert.throws(() => buildMtaStsPolicy({ mode: "testing", mx: [mx], maxAge: 86400 }), /mx/i, JSON.stringify(mx));
	}
	assert.throws(() => buildMtaStsPolicy({ mode: "testing", mx: [], maxAge: 86400 }), /mx/i);
	assert.throws(() => buildMtaStsPolicy({ mode: "weird", mx: ["mx.example.net"], maxAge: 86400 }), /mode/i);
	assert.throws(() => buildMtaStsPolicy({ mode: "testing", mx: Array.from({ length: MTA_STS_LIMITS.maxMx + 1 }, (_, index) => `mx${index}.example.net`), maxAge: 86400 }), /mx/i);
});

test("max_age is a whole number of seconds from one day to one year", () => {
	assert.deepEqual([parseMaxAge(undefined), parseMaxAge(86400), parseMaxAge(31_557_600), parseMaxAge("604800")], [604800, 86400, 31_557_600, null]);
	for (const bad of [0, 86399, 31_557_601, -1, 1.5, "x", null, Number.NaN, Infinity]) assert.equal(parseMaxAge(bad), null, String(bad));
	assert.throws(() => buildMtaStsPolicy({ mode: "testing", mx: ["mx.example.net"], maxAge: 5 }), /max_age/i);
});

test("normalizeMx lowercases, drops a trailing dot, removes duplicates and refuses anything else", () => {
	assert.deepEqual(normalizeMx(["MX.Example.NET.", "mx.example.net", "a.example.net"]), ["a.example.net", "mx.example.net"]);
	assert.equal(normalizeMx(["bad host"]), null);
});

test("the host guard only ever answers for mta-sts.<domain>: case-insensitive, prefix only, exact path", () => {
	assert.equal(mtaStsHostDomain("mta-sts.example.com"), "example.com");
	assert.equal(mtaStsHostDomain("MTA-STS.Example.COM"), "example.com");
	assert.equal(mtaStsHostDomain("mta-sts.example.com."), "example.com");
	assert.equal(mtaStsHostDomain("mta-sts.sub.example.co.uk"), "sub.example.co.uk");
	for (const host of ["example.com", "xmta-sts.example.com", "www.mta-sts.example.com", "mta-sts.", "mta-sts", "mta-sts..com", "mta-sts.exa_mple.com", "mta-sts.example.com:8080", "mta-sts.-x.com", ""]) assert.equal(mtaStsHostDomain(host), null, host);
});

test("guardMtaStsHost: other hosts pass through; on the mta-sts host only the policy path is allowed", async () => {
	const g = (hostname, pathname, method = "GET") => guardMtaStsHost({ hostname, pathname, method });
	assert.equal(g("mail.example.com", "/login"), null);
	assert.equal(g("mail.example.com", "/.well-known/mta-sts.txt"), null, "the app host is not special; the route itself answers 404 there");
	assert.equal(g("mta-sts.example.com", "/.well-known/mta-sts.txt"), null);
	assert.equal(g("MTA-STS.EXAMPLE.COM", "/.well-known/mta-sts.txt", "HEAD"), null);
	for (const path of ["/", "/login", "/api/auth/login", "/.well-known/mta-sts.txt/", "/.well-known/MTA-STS.txt", "/.well-known/jmap", "//.well-known/mta-sts.txt", "/.well-known/mta-sts.txt/x", "/_next/static/a.js", "/api/realtime"]) {
		const response = g("mta-sts.example.com", path);
		assert.equal(response?.status, 404, path);
	}
	const post = g("mta-sts.example.com", "/.well-known/mta-sts.txt", "POST");
	assert.equal(post.status, 405);
	assert.equal(post.headers.get("allow"), "GET, HEAD");
});

test("the policy id is a UTC timestamp that always moves forward", () => {
	assert.equal(nextPolicyId(new Date("2025-11-19T12:34:56Z"), null), "20251119123456");
	assert.equal(nextPolicyId(new Date("2025-11-19T12:34:56Z"), "20251119123400"), "20251119123456");
	assert.equal(nextPolicyId(new Date("2025-11-19T12:34:56Z"), "20251119123456"), "20251119123457", "a change within the same second still gets a new id");
	assert.equal(nextPolicyId(new Date("2025-11-19T12:34:56Z"), "20251119235959"), "20251120000000", "and a clock that went backwards never reuses an id");
	assert.equal(nextPolicyId(new Date("2025-11-19T12:34:56Z"), "garbage"), "20251119123456");
});

async function fixture(t, rows = {}) {
	const database = new SqliteDatabase(join(outDir, `${crypto.randomUUID()}.sqlite`));
	t.after(() => database.db.close());
	await applyMigrations(database, join(root, "drizzle/migrations"));
	const now = 1_700_000_000;
	database.db.prepare("INSERT INTO users (id, email, name, password_hash, created_at) VALUES ('u1', 'k@example.com', 'K', 'x', ?)").run(now);
	for (const [id, hostname] of [["d1", "example.com"], ["d2", "other.org"]]) database.db.prepare("INSERT INTO domains (id, user_id, hostname, zone_id, created_at) VALUES (?, 'u1', ?, 'z', ?)").run(id, hostname, now);
	const set = (id, { mode = "testing", policyId = "20251119000000", mx = '["mx.example.net","a.example.net"]', maxAge = 604800 } = {}) => database.db.prepare("INSERT OR REPLACE INTO domain_deliverability (domain_id, updated_at, mta_sts_mode, mta_sts_policy_id, mta_sts_mx, mta_sts_max_age) VALUES (?, ?, ?, ?, ?, ?)").run(id, now, mode, policyId, mx, maxAge);
	if (rows.d1) set("d1", rows.d1);
	if (rows.d2) set("d2", rows.d2);
	const get = (host, { path = "/.well-known/mta-sts.txt", method = "GET" } = {}) => serveMtaStsPolicy({ DB: database }, new Request(`https://${host}${path}`, { method }));
	return { get, set, raw: database.db, serveRaw: (request) => serveMtaStsPolicy({ DB: database }, request) };
}

test("serves the configured policy as text/plain with the documented headers", async (t) => {
	const f = await fixture(t, { d1: {} });
	const response = await f.get("mta-sts.example.com");
	assert.equal(response.status, 200);
	assert.equal(response.headers.get("content-type"), "text/plain; charset=utf-8");
	assert.equal(response.headers.get("cache-control"), "public, max-age=300");
	assert.equal(response.headers.get("access-control-allow-origin"), "*");
	assert.equal(response.headers.get("x-content-type-options"), "nosniff");
	assert.equal(response.headers.get("location"), null);
	assert.equal(await response.text(), "version: STSv1\r\nmode: testing\r\nmx: a.example.net\r\nmx: mx.example.net\r\nmax_age: 604800\r\n");
	assert.equal((await f.get("MTA-STS.EXAMPLE.COM")).status, 200);
});

test("HEAD answers like GET without a body", async (t) => {
	const f = await fixture(t, { d1: {} });
	const response = await f.get("mta-sts.example.com", { method: "HEAD" });
	assert.equal(response.status, 200);
	assert.equal(await response.text(), "");
	assert.equal(response.headers.get("content-type"), "text/plain; charset=utf-8");
});

test("404 for any host that is not mta-sts.<a configured domain>, with no echo of the request", async (t) => {
	const f = await fixture(t, { d1: {} });
	for (const host of ["example.com", "mta-sts.other.org", "mta-sts.unknown.test", "mta-sts.sub.example.com", "evil-mta-sts.example.com", "mta-sts.example.com.evil.test"]) {
		const response = await f.get(host);
		assert.equal(response.status, 404, host);
		const body = await response.text();
		assert.ok(!body.includes(host), "the host is never reflected");
	}
	const odd = await f.get("mta-sts.example.com", { path: "/.well-known/mta-sts.txt?x=%0d%0amode:%20none&host=evil" });
	assert.equal(await odd.text(), "version: STSv1\r\nmode: testing\r\nmx: a.example.net\r\nmx: mx.example.net\r\nmax_age: 604800\r\n");
});

test("a domain without a policy id is not served; one in its removal period serves mode none; once retired it is 404 again", async (t) => {
	const f = await fixture(t, { d1: { mode: "none", policyId: null } });
	assert.equal((await f.get("mta-sts.example.com")).status, 404);
	f.set("d1", { mode: "none", policyId: "20251119000001", maxAge: 86400 });
	const retiring = await f.get("mta-sts.example.com");
	assert.equal(retiring.status, 200);
	assert.match(await retiring.text(), /^version: STSv1\r\nmode: none\r\n/);
	f.set("d1", { mode: "none", policyId: null });
	assert.equal((await f.get("mta-sts.example.com")).status, 404);
});

test("a stored policy that no longer validates is not served, and a missing table is a 404", async (t) => {
	const f = await fixture(t, { d1: { mx: '["bad host"]' } });
	assert.equal((await f.get("mta-sts.example.com")).status, 404);
	f.set("d1", { mx: "not json" });
	assert.equal((await f.get("mta-sts.example.com")).status, 404);
	f.set("d1", { mx: "[]" });
	assert.equal((await f.get("mta-sts.example.com")).status, 404);
	f.set("d1", { maxAge: 5 });
	assert.equal((await f.get("mta-sts.example.com")).status, 404);
	f.raw.exec("DROP TABLE domain_deliverability");
	assert.equal((await f.get("mta-sts.example.com")).status, 404);
});

test("on Node the request URL carries the bind address, so the domain comes from the Host header", async (t) => {
	const f = await fixture(t, { d1: {} });
	const serve = (host) => f.serveRaw(new Request("http://0.0.0.0:3000/.well-known/mta-sts.txt", { headers: { host } }));
	const published = await serve("mta-sts.example.com");
	assert.equal(published.status, 200);
	assert.match(await published.text(), /^version: STSv1\r\nmode: testing\r\n/);
	assert.equal((await serve("mta-sts.example.com:3000")).status, 200, "a port in the Host header is ignored");
	assert.equal((await serve("mta-sts.unknown.test")).status, 404);
	assert.equal((await serve("0.0.0.0:3000")).status, 404, "a request with no mta-sts host never serves");
});

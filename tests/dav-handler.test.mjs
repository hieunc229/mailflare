import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(join(root, "tests", ".tmp-dav-handler-"));
after(() => rmSync(outDir, { recursive: true, force: true }));

await build({
	stdin: {
		contents: `
			export { handleDavRequest, isDavPath } from "./src/lib/dav/handler.ts";
			export { isDavEnabled, clearDavEnabledCache } from "./src/lib/dav/settings.ts";
			export { generateAppPassword, generateApiKey } from "./src/lib/api-keys.ts";
			export { clearApiKeyVerificationCache } from "./src/lib/api/find-api-key.ts";
			export { availableAppPasswordProtocols } from "./src/lib/auth/app-passwords.ts";
			export { SqliteDatabase } from "./server/runtime/sqlite-database.ts";
			export { applyMigrations } from "./server/runtime/migrate.ts";
		`,
		resolveDir: root,
		sourcefile: "dav-handler-entry.ts",
	},
	outfile: join(outDir, "entry.mjs"),
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node22",
	tsconfig: join(root, "tsconfig.json"),
	packages: "external",
	alias: { "cloudflare:workers": "./server/runtime/cloudflare-workers.ts" },
	logLevel: "silent",
});

const { handleDavRequest, isDavPath, isDavEnabled, clearDavEnabledCache, generateAppPassword, generateApiKey, clearApiKeyVerificationCache, availableAppPasswordProtocols, SqliteDatabase, applyMigrations } = await import(pathToFileURL(join(outDir, "entry.mjs")).href);

const ORIGIN = "https://mail.example.test";

async function fixture(t, { enabled = true, calendarEnabled = true, limiter } = {}) {
	clearApiKeyVerificationCache();
	clearDavEnabledCache();
	const database = new SqliteDatabase(":memory:");
	t.after(() => {
		database.db.close();
		clearApiKeyVerificationCache();
		clearDavEnabledCache();
	});
	await applyMigrations(database, join(root, "drizzle/migrations"));
	const insertUser = database.db.prepare("INSERT INTO users (id, email, name, password_hash, role, calendar_enabled, created_at) VALUES (?, ?, ?, 'x', 'user', ?, 1)");
	insertUser.run("u1", "u1@one.test", "User One", calendarEnabled ? 1 : 0);
	insertUser.run("u2", "u2@one.test", "User Two", 1);
	database.db.prepare("INSERT INTO domains (id, user_id, zone_id, hostname, created_at) VALUES ('d1', 'u1', 'z', 'one.test', 1)").run();
	database.db.prepare("INSERT INTO mailboxes (id, user_id, domain_id, local_part, created_at) VALUES ('m1', 'u1', 'd1', 'sales', 1)").run();
	if (enabled) database.db.prepare("UPDATE app_settings SET dav_enabled = 1 WHERE id = 'default'").run();
	const env = { DB: database, DAV_RATE_LIMIT: limiter };
	const key = await generateAppPassword();
	database.db
		.prepare("INSERT INTO api_keys (id, user_id, name, prefix, key_hash, key_sha256, kind, scopes, created_at) VALUES ('k1', 'u1', 'phone', ?, ?, ?, 'app', '[\"dav\"]', 1)")
		.run(key.prefix, key.hash, key.sha256);
	return { database, env, key };
}

const basic = (password) => `Basic ${Buffer.from(`me@example.test:${password}`).toString("base64")}`;
const dav = (env, method, path, { key, body, headers = {}, origin = ORIGIN } = {}) =>
	handleDavRequest(new Request(`${origin}${path}`, { method, body, headers: { ...(key ? { Authorization: basic(key.fullKey) } : {}), ...headers } }), env);
const propfind = (env, path, key, body, depth = "0", headers = {}) => dav(env, "PROPFIND", path, { key, body, headers: { Depth: depth, "Content-Type": "application/xml", ...headers } });
const PROP = (names) => `<?xml version="1.0"?><A:propfind xmlns:A="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav" xmlns:R="urn:ietf:params:xml:ns:carddav"><A:prop>${names}</A:prop></A:propfind>`;

test("only /dav and the two well-known paths are DAV paths", () => {
	for (const path of ["/dav", "/dav/", "/dav/principals/u1/", "/.well-known/caldav", "/.well-known/carddav"]) assert.equal(isDavPath(path), true, path);
	for (const path of ["/davx", "/api/dav", "/.well-known/jmap", "/", "/dav-x/"]) assert.equal(isDavPath(path), false, path);
});

test("anything that is not a DAV path falls through", async (t) => {
	const { env } = await fixture(t);
	assert.equal(await dav(env, "GET", "/api/messages"), null);
});

test("off by default: every DAV path is 404, even with a valid app password", async (t) => {
	const { env, key } = await fixture(t, { enabled: false });
	for (const path of ["/dav/", "/.well-known/caldav", "/.well-known/carddav", "/dav/principals/u1/"]) {
		assert.equal((await dav(env, "OPTIONS", path)).status, 404, path);
		assert.equal((await propfind(env, path, key, PROP("<A:displayname/>"))).status, 404, path);
	}
});

test("a database without the column counts as off", async (t) => {
	const { env, database } = await fixture(t);
	database.db.exec("DROP TABLE app_settings; CREATE TABLE app_settings (id text primary key)");
	clearDavEnabledCache();
	assert.equal(await isDavEnabled(env), false);
	assert.equal((await dav(env, "OPTIONS", "/dav/")).status, 404);
});

test("the switch is cached briefly in the isolate and can be cleared", async (t) => {
	const { env, database } = await fixture(t);
	assert.equal(await isDavEnabled(env), true);
	database.db.prepare("UPDATE app_settings SET dav_enabled = 0").run();
	assert.equal(await isDavEnabled(env), true);
	clearDavEnabledCache();
	assert.equal(await isDavEnabled(env), false);
});

test("dav is offered as an app password protocol only while enabled", async (t) => {
	const { env, database } = await fixture(t);
	assert.deepEqual(await availableAppPasswordProtocols(env), ["jmap", "dav"]);
	database.db.prepare("UPDATE app_settings SET dav_enabled = 0").run();
	clearDavEnabledCache();
	assert.deepEqual(await availableAppPasswordProtocols(env), ["jmap"]);
});

test("OPTIONS answers without credentials and advertises DAV classes", async (t) => {
	const { env } = await fixture(t);
	const response = await dav(env, "OPTIONS", "/dav/principals/u1/");
	assert.equal(response.status, 200);
	assert.match(response.headers.get("DAV"), /calendar-access/);
	assert.match(response.headers.get("DAV"), /addressbook/);
	assert.match(response.headers.get("Allow"), /PROPFIND/);
	assert.equal(response.headers.get("Cache-Control"), "no-store");
	assert.equal(response.headers.get("Access-Control-Allow-Origin"), null);
});

test("well-known redirects without credentials and answers in place with them", async (t) => {
	const { env, key } = await fixture(t);
	for (const kind of ["caldav", "carddav"]) {
		const redirect = await dav(env, "PROPFIND", `/.well-known/${kind}`, { headers: { Depth: "0" } });
		assert.equal(redirect.status, 301);
		assert.equal(redirect.headers.get("Location"), `${ORIGIN}/dav/`);
		const inPlace = await propfind(env, `/.well-known/${kind}`, key, PROP("<A:current-user-principal/>"));
		assert.equal(inPlace.status, 207);
		assert.match(await inPlace.text(), /<D:href>\/dav\/principals\/u1\/<\/D:href>/);
	}
});

test("credentials: none, wrong, wrong protocol and wrong kind are all 401, plain HTTP is 403 with an explanation", async (t) => {
	const { env, key, database } = await fixture(t);
	const body = PROP("<A:displayname/>");
	const none = await propfind(env, "/dav/", undefined, body);
	assert.equal(none.status, 401);
	assert.match(none.headers.get("WWW-Authenticate"), /^Basic realm="Mailflare", charset="UTF-8"$/);
	assert.equal((await propfind(env, "/dav/", { fullKey: "x".repeat(16) }, body)).status, 401);

	// Plain HTTP: refused before any lookup, and no challenge to loop on.
	const http = await propfind(env, "/dav/", key, body, "0", {});
	assert.equal(http.status, 207);
	const insecure = await dav(env, "PROPFIND", "/dav/", { key, origin: "http://mail.example.test", body, headers: { Depth: "0", "Content-Type": "application/xml" } });
	assert.equal(insecure.status, 403);
	assert.equal(insecure.headers.get("WWW-Authenticate"), null);
	assert.match(await insecure.text(), /HTTPS.*TRUST_PROXY/s);

	const jmapOnly = await generateAppPassword();
	database.db.prepare("INSERT INTO api_keys (id, user_id, name, prefix, key_hash, key_sha256, kind, scopes, created_at) VALUES ('k2', 'u1', 'j', ?, ?, ?, 'app', '[\"jmap\"]', 1)").run(jmapOnly.prefix, jmapOnly.hash, jmapOnly.sha256);
	assert.equal((await propfind(env, "/dav/", jmapOnly, body)).status, 401);
	const general = await generateApiKey();
	database.db.prepare("INSERT INTO api_keys (id, user_id, name, prefix, key_hash, key_sha256, kind, scopes, created_at) VALUES ('k3', 'u1', 'g', ?, ?, ?, 'legacy', '[\"dav\"]', 1)").run(general.prefix, general.hash, general.sha256);
	assert.equal((await propfind(env, "/dav/", general, body)).status, 401);
});

test("guessing is throttled with 429 before the lookup", async (t) => {
	const limiter = { calls: 0, async limit() { this.calls++; return { success: false }; } };
	const { env } = await fixture(t, { limiter: undefined });
	env.DEVICE_LOGIN_RATE_LIMIT = limiter;
	const response = await propfind(env, "/dav/", { fullKey: "g".repeat(16) }, PROP("<A:displayname/>"));
	assert.equal(response.status, 429);
	assert.equal(response.headers.get("Retry-After"), "60");
	assert.equal(limiter.calls, 1);
});

test("a key over its per-key budget gets 503 with Retry-After", async (t) => {
	const keys = [];
	const limiter = { async limit({ key }) { keys.push(key); return { success: false }; } };
	const { env, key } = await fixture(t, { limiter });
	const response = await propfind(env, "/dav/", key, PROP("<A:displayname/>"));
	assert.equal(response.status, 503);
	assert.equal(response.headers.get("Retry-After"), "30");
	assert.deepEqual(keys, ["dav:k1"]);
});

test("the root names the current user principal", async (t) => {
	const { env, key } = await fixture(t);
	const response = await propfind(env, "/dav/", key, PROP("<A:current-user-principal/><A:resourcetype/>"));
	assert.equal(response.status, 207);
	assert.match(response.headers.get("Content-Type"), /^application\/xml/);
	const text = await response.text();
	assert.match(text, /<D:href>\/dav\/<\/D:href>/);
	assert.match(text, /<D:current-user-principal><D:href>\/dav\/principals\/u1\/<\/D:href><\/D:current-user-principal>/);
	assert.match(text, /<D:resourcetype><D:collection\/><\/D:resourcetype>/);
});

test("the principal lists the home sets and the user's addresses", async (t) => {
	const { env, key } = await fixture(t);
	const names = "<A:displayname/><A:resourcetype/><A:principal-URL/><C:calendar-home-set/><R:addressbook-home-set/><C:calendar-user-address-set/>";
	const response = await propfind(env, "/dav/principals/u1/", key, PROP(names));
	assert.equal(response.status, 207);
	const text = await response.text();
	assert.match(text, /<D:displayname>User One<\/D:displayname>/);
	assert.match(text, /<D:resourcetype><D:collection\/><D:principal\/><\/D:resourcetype>/);
	assert.match(text, /<D:principal-URL><D:href>\/dav\/principals\/u1\/<\/D:href><\/D:principal-URL>/);
	assert.match(text, /<C:calendar-home-set><D:href>\/dav\/calendars\/u1\/<\/D:href><\/C:calendar-home-set>/);
	assert.match(text, /<CR:addressbook-home-set><D:href>\/dav\/addressbooks\/u1\/<\/D:href><\/CR:addressbook-home-set>/);
	assert.match(text, /<D:href>mailto:u1@one\.test<\/D:href>/);
	assert.match(text, /<D:href>mailto:sales@one\.test<\/D:href>/);
});

test("another user's paths are 404, not 403", async (t) => {
	const { env, key } = await fixture(t);
	for (const path of ["/dav/principals/u2/", "/dav/calendars/u2/", "/dav/addressbooks/u2/", "/dav/principals/nobody/"]) {
		assert.equal((await propfind(env, path, key, PROP("<A:displayname/>"))).status, 404, path);
	}
});

test("home sets answer at depth 0 and 1; the calendar home needs calendars enabled", async (t) => {
	const { env, key } = await fixture(t);
	for (const path of ["/dav/calendars/u1/", "/dav/addressbooks/u1/", "/dav/calendars/u1"]) {
		for (const depth of ["0", "1"]) assert.equal((await propfind(env, path, key, PROP("<A:resourcetype/>"), depth)).status, 207, `${path} ${depth}`);
	}
	const off = await fixture(t, { calendarEnabled: false });
	assert.equal((await propfind(off.env, "/dav/calendars/u1/", off.key, PROP("<A:resourcetype/>"))).status, 403);
	assert.equal((await propfind(off.env, "/dav/addressbooks/u1/", off.key, PROP("<A:resourcetype/>"))).status, 207);
});

test("unknown properties come back 404 in their own propstat; propname lists names", async (t) => {
	const { env, key } = await fixture(t);
	const text = await (await propfind(env, "/dav/", key, `<?xml version="1.0"?><propfind xmlns="DAV:" xmlns:X="urn:x"><prop><displayname/><X:nope/></prop></propfind>`)).text();
	assert.match(text, /HTTP\/1\.1 404 Not Found/);
	assert.match(text, /<nope xmlns="urn:x"\/>/);
	const names = await (await propfind(env, "/dav/", key, `<propfind xmlns="DAV:"><propname/></propfind>`)).text();
	assert.match(names, /<D:current-user-principal\/>/);
	const all = await (await propfind(env, "/dav/", key, undefined)).text();
	assert.match(all, /<D:current-user-principal>/);
});

test("Depth infinity, or no Depth, is refused with propfind-finite-depth", async (t) => {
	const { env, key } = await fixture(t);
	for (const depth of ["infinity", undefined]) {
		const response = await dav(env, "PROPFIND", "/dav/", { key, body: PROP("<A:displayname/>"), headers: depth ? { Depth: depth, "Content-Type": "application/xml" } : { "Content-Type": "application/xml" } });
		assert.equal(response.status, 403);
		assert.match(await response.text(), /<D:propfind-finite-depth\/>/);
	}
	assert.equal((await propfind(env, "/dav/", key, PROP("<A:displayname/>"), "2")).status, 400);
});

test("request bodies are checked before and while they are read", async (t) => {
	const { env, key } = await fixture(t);
	// DOCTYPE
	const xxe = `<?xml version="1.0"?><!DOCTYPE x [<!ENTITY e SYSTEM "file:///etc/passwd">]><propfind xmlns="DAV:"><prop><displayname/></prop></propfind>`;
	assert.equal((await propfind(env, "/dav/", key, xxe)).status, 400);
	// Not a propfind
	assert.equal((await propfind(env, "/dav/", key, `<a xmlns="DAV:"/>`)).status, 400);
	assert.equal((await propfind(env, "/dav/", key, `<propfind xmlns="DAV:"><bogus/></propfind>`)).status, 400);
	assert.equal((await propfind(env, "/dav/", key, "not xml")).status, 400);
	// Wrong content type
	assert.equal((await propfind(env, "/dav/", key, PROP("<A:displayname/>"), "0", { "Content-Type": "application/json" })).status, 415);
	// Declared and undeclared oversize
	const big = `<propfind xmlns="DAV:">${" ".repeat(256 * 1024 + 1)}<prop/></propfind>`;
	assert.equal((await propfind(env, "/dav/", key, big)).status, 413);
	const stream = new ReadableStream({ start(controller) { for (let i = 0; i < 300; i++) controller.enqueue(new TextEncoder().encode(" ".repeat(1024))); controller.close(); } });
	const streamed = await handleDavRequest(new Request(`${ORIGIN}/dav/`, { method: "PROPFIND", body: stream, duplex: "half", headers: { Authorization: basic(key.fullKey), Depth: "0", "Content-Type": "application/xml", "Transfer-Encoding": "chunked" } }), env);
	assert.equal(streamed.status, 413);
});

test("everything this PR does not serve yet is refused cleanly", async (t) => {
	const { env, key } = await fixture(t);
	for (const method of ["GET", "PUT", "DELETE", "PROPPATCH", "REPORT", "LOCK", "UNLOCK", "POST"]) assert.equal((await dav(env, method, "/dav/principals/u1/", { key })).status, 405, method);
	for (const method of ["MKCALENDAR", "MKCOL"]) assert.equal((await dav(env, method, "/dav/calendars/u1/new/", { key })).status, 403, method);
	assert.equal((await propfind(env, "/dav/calendars/u1/default/", key, PROP("<A:displayname/>"))).status, 404);
	assert.equal((await propfind(env, "/dav/elsewhere/", key, PROP("<A:displayname/>"))).status, 404);
	const allowed = (await dav(env, "GET", "/dav/", { key })).headers.get("Allow");
	assert.match(allowed, /PROPFIND/);
});

test("DAV responses carry the baseline security headers, switch off or on", async (t) => {
	const off = await fixture(t, { enabled: false });
	const on = await fixture(t);
	const responses = [
		await dav(off.env, "PROPFIND", "/dav/"),
		await dav(on.env, "OPTIONS", "/dav/"),
		await dav(on.env, "PROPFIND", "/dav/"),
		await propfind(on.env, "/dav/", on.key, PROP("<A:displayname/>")),
		await dav(on.env, "GET", "/.well-known/caldav"),
	];
	for (const response of responses) {
		assert.match(response.headers.get("Strict-Transport-Security") ?? "", /max-age=/);
		assert.equal(response.headers.get("X-Content-Type-Options"), "nosniff");
		assert.equal(response.headers.get("Referrer-Policy"), "strict-origin-when-cross-origin");
		assert.equal(response.headers.get("Cache-Control"), "no-store");
	}
});

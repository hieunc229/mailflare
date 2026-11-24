import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test, { after } from "node:test";
import { installSqlite, loadFixture } from "./helpers/fixtures.mjs";

const { migrations } = JSON.parse(readFileSync(new URL("../src/lib/migrations/bundle.json", import.meta.url), "utf8"));
const schema = "PRAGMA foreign_keys = OFF;\n" + migrations.flatMap((migration) => migration.statements).join(";\n");

const mocks = {
	"next/server": "export const NextResponse={json:(data,init)=>Response.json(data,init)};",
	"@/db": "export function getDb(){return globalThis.appPwRoute.db}",
	"@/lib/cloudflare": "export function getEnv(){return {}}",
	"@/lib/api/auth": "export async function requireSessionUser(){const s=globalThis.appPwRoute;return s.user?{user:s.user,error:null}:{user:null,error:Response.json({error:'Unauthorized'},{status:401})}}",
	"@/lib/auth/cookies": "export async function requireUser(){return globalThis.appPwRoute.user}",
	"@/lib/auth/session": "export function getSessionTokenFromRequestHeaders(){return 'session-1'} export async function hashSessionToken(token){return 'hash-'+token}",
	"@/lib/mailboxes/access": "export async function getMailboxAccessLevel(db,user,id){return globalThis.appPwRoute.readable.includes(id)?{canRead:true}:null}",
	"@/lib/auth/activity": "export async function recordAuthActivity(env,input){globalThis.appPwRoute.audit.push(input.action)}",
	// The app-password module pulls in the verification stack, which these routes do not use.
	"@/lib/auth/app-passwords": "export async function availableAppPasswordProtocols(){return globalThis.appPwRoute.protocols ?? ['jmap']}",
};

const route = await loadFixture({ name: "app-password-route", entryPoint: "src/app/api/app-passwords/route.ts", mocks });
const itemRoute = await loadFixture({ name: "app-password-item-route", entryPoint: "src/app/api/app-passwords/[id]/route.ts", mocks });
const grants = await loadFixture({ name: "app-password-grants", entryPoint: "src/lib/auth/webauthn/grants.ts", mocks });
const apiKeysRoute = await loadFixture({
	name: "app-password-api-keys",
	entryPoint: "src/app/api/api-keys/route.ts",
	mocks: { ...mocks, "@/lib/auth/origin": "export function hasValidSessionMutationOrigin(){return true}" },
});
const { GET, POST } = await route.import();
const { DELETE } = await itemRoute.import();
const { createStepUpGrant } = await grants.import();
const { GET: listApiKeys, POST: createApiKey } = await apiKeysRoute.import();
let sqlite;
after(() => {
	sqlite?.close();
	delete globalThis.appPwRoute;
	for (const fixture of [route, itemRoute, grants, apiKeysRoute]) fixture.dispose();
});

function setup({ user = { id: "u1", role: "user", securityVersion: 0 }, readable = ["m1", "m2"] } = {}) {
	sqlite?.close();
	sqlite = installSqlite("appPwRoute", { schema, extra: { user, readable, audit: [] } });
	sqlite.exec(`INSERT INTO users (id, email, name, password_hash, role, created_at) VALUES ('u1', 'u1@one.test', 'U', 'x', 'user', 1), ('u2', 'u2@one.test', 'U', 'x', 'user', 1)`);
	for (const id of ["m1", "m2"]) sqlite.exec(`INSERT INTO mailboxes (id, user_id, domain_id, local_part, created_at) VALUES ('${id}', 'u1', 'd', '${id}', 1)`);
}

const grant = (action = "app_password.create", sessionToken = "session-1") => createStepUpGrant({}, { userId: "u1", sessionToken, action, expectedActorSecurityVersion: 0 });
const post = (body, headers = { "Sec-Fetch-Site": "same-origin" }) =>
	POST(new Request("https://mail.test/api/app-passwords", { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) }));
const valid = (stepUpToken, overrides = {}) => ({ name: "iPhone", protocols: ["jmap"], mailboxIds: ["m1"], stepUpToken, ...overrides });
const keys = () => sqlite.prepare("SELECT * FROM api_keys").all();
const unspentGrants = () => sqlite.prepare("SELECT count(*) AS n FROM auth_step_ups WHERE used_at IS NULL").get().n;

test("creating an app password needs a step-up grant", async () => {
	setup();
	const missing = await post({ name: "iPhone", protocols: ["jmap"], mailboxIds: ["m1"] });
	assert.equal(missing.status, 400);
	assert.equal((await missing.json()).code, "verification_required");
	const forged = await post(valid("sup-not-a-real-grant"));
	assert.equal(forged.status, 401);
	assert.equal((await forged.json()).code, "verification_required");
	assert.equal(keys().length, 0);
});

test("a grant minted for another action cannot create one", async () => {
	setup();
	const response = await post(valid(await grant("passkey.add")));
	assert.equal(response.status, 401);
	assert.equal(keys().length, 0);
	assert.equal(unspentGrants(), 1);
});

test("a grant from another session cannot create one", async () => {
	setup();
	const response = await post(valid(await grant("app_password.create", "someone-elses-session")));
	assert.equal(response.status, 401);
	assert.equal(keys().length, 0);
});

test("a valid grant creates a mailbox-scoped app password, shown once, and is spent", async () => {
	setup();
	const token = await grant();
	const response = await post(valid(token, { mailboxIds: ["m1", "m2", "m1"] }));
	assert.equal(response.status, 200);
	assert.equal(response.headers.get("cache-control"), "no-store");
	const body = await response.json();
	assert.match(body.key, /^[0-9a-zA-Z]{16}$/);
	assert.deepEqual(body.protocols, ["jmap"]);
	const [row] = keys();
	assert.equal(row.kind, "app");
	assert.equal(row.user_id, "u1");
	assert.equal(row.name, "iPhone");
	assert.equal(row.scopes, '["jmap"]');
	assert.equal(row.mailbox_scope_enabled, 1);
	assert.equal(row.prefix, body.key.slice(0, 6));
	assert.notEqual(row.key_sha256, body.key);
	assert.deepEqual(sqlite.prepare("SELECT mailbox_id FROM mcp_key_mailboxes WHERE key_id = ? ORDER BY mailbox_id").all(row.id).map((r) => r.mailbox_id), ["m1", "m2"]);
	assert.deepEqual(globalThis.appPwRoute.audit, ["auth.app_password_created"]);
	assert.equal((await post(valid(token))).status, 401, "the grant is single use");
	assert.equal(keys().length, 1);
});

test("protocols the server cannot serve yet are refused, and keep the grant", async () => {
	setup();
	const token = await grant();
	for (const protocols of [["dav"], ["imap"], ["submission"], ["jmap", "dav"], ["caldav"], ["*"], [], "jmap"]) {
		const response = await post(valid(token, { protocols }));
		assert.equal(response.status, 400, JSON.stringify(protocols));
	}
	assert.equal(keys().length, 0);
	assert.equal(unspentGrants(), 1);
});

test("a name is required and bounded", async () => {
	setup();
	const token = await grant();
	assert.equal((await post(valid(token, { name: "   " }))).status, 400);
	assert.equal((await post(valid(token, { name: "x".repeat(101) }))).status, 400);
	assert.equal(keys().length, 0);
});

test("mailboxes are required and must be readable by the user", async () => {
	setup();
	const token = await grant();
	assert.equal((await post(valid(token, { mailboxIds: [] }))).status, 400);
	assert.equal((await post(valid(token, { mailboxIds: ["m1", "not-mine"] }))).status, 403);
	assert.equal((await post(valid(token, { mailboxIds: Array.from({ length: 31 }, (_, i) => `m${i}`) }))).status, 400);
	assert.equal(keys().length, 0);
	assert.equal(unspentGrants(), 1);
});

test("cross-site requests and signed-out callers are refused", async () => {
	setup();
	const token = await grant();
	assert.equal((await post(valid(token), { "Sec-Fetch-Site": "cross-site" })).status, 403);
	assert.equal((await post(valid(token), {})).status, 403);
	setup({ user: null });
	assert.equal((await post(valid("sup-x"))).status, 401);
	assert.equal((await GET(new Request("https://mail.test/api/app-passwords"))).status, 401);
	assert.equal(keys().length, 0);
});

function addKey({ id, userId = "u1", kind = "app", scopes = '["jmap"]', createdAt = 1, usedAt = null, protocol = null, ip = null }) {
	sqlite.prepare("INSERT INTO api_keys (id, user_id, name, prefix, key_hash, key_sha256, kind, scopes, created_at, last_used_at, last_used_protocol, last_used_ip) VALUES (?, ?, ?, 'p', 'h', ?, ?, ?, ?, ?, ?, ?)").run(id, userId, `name-${id}`, `sha-${id}`, kind, scopes, createdAt, usedAt, protocol, ip);
}

test("the list shows own app passwords and older JMAP keys, with last protocol and IP", async () => {
	setup();
	addKey({ id: "app", scopes: '["jmap"]', createdAt: 30, usedAt: 100, protocol: "jmap", ip: "203.0.113.5" });
	addKey({ id: "legacy-jmap", kind: "legacy", scopes: '["jmap"]', createdAt: 20 });
	addKey({ id: "device", kind: "device" });
	addKey({ id: "general", kind: "legacy", scopes: '["read","send"]' });
	addKey({ id: "mixed", kind: "legacy", scopes: '["jmap","send"]' });
	addKey({ id: "mcp", kind: "mcp", scopes: '["mcp:read"]' });
	addKey({ id: "theirs", userId: "u2" });
	const response = await GET(new Request("https://mail.test/api/app-passwords"));
	assert.equal(response.status, 200);
	const body = await response.json();
	assert.deepEqual(body.availableProtocols, ["jmap"]);
	assert.deepEqual(body.appPasswords.map((item) => item.id), ["app", "legacy-jmap"]);
	const [app, legacy] = body.appPasswords;
	assert.equal(app.legacy, false);
	assert.deepEqual(app.protocols, ["jmap"]);
	assert.equal(app.lastUsedProtocol, "jmap");
	assert.equal(app.lastUsedIp, "203.0.113.5");
	assert.ok(app.lastUsedAt);
	assert.equal(legacy.legacy, true);
	assert.equal(legacy.lastUsedAt, null);
	assert.equal(JSON.stringify(body).includes("sha-app"), false, "no hash leaves the server");
});

const revoke = (id, headers = { "Sec-Fetch-Site": "same-origin" }) =>
	DELETE(new Request(`https://mail.test/api/app-passwords/${id}`, { method: "DELETE", headers }), { params: Promise.resolve({ id }) });

test("revoking deletes an app password or an older JMAP key, and nothing else", async () => {
	setup();
	addKey({ id: "app" });
	addKey({ id: "legacy-jmap", kind: "legacy" });
	addKey({ id: "device", kind: "device" });
	addKey({ id: "general", kind: "legacy", scopes: '["read","send"]' });
	addKey({ id: "mixed", kind: "legacy", scopes: '["jmap","send"]' });
	addKey({ id: "theirs", userId: "u2" });
	assert.equal((await revoke("app")).status, 200);
	assert.equal((await revoke("legacy-jmap")).status, 200);
	for (const id of ["device", "general", "mixed", "theirs", "missing"]) assert.equal((await revoke(id)).status, 404, id);
	assert.deepEqual(keys().map((row) => row.id).sort(), ["device", "general", "mixed", "theirs"]);
	assert.equal((await revoke("device", {})).status, 403);
	assert.deepEqual(globalThis.appPwRoute.audit, ["auth.app_password_revoked", "auth.app_password_revoked"]);
});

test("the general API key list shows no app password, old or new, but keeps mixed keys", async () => {
	setup();
	addKey({ id: "app" });
	addKey({ id: "legacy-jmap", kind: "legacy" });
	addKey({ id: "mixed", kind: "legacy", scopes: '["jmap","send"]' });
	addKey({ id: "general", kind: "legacy", scopes: '["read"]' });
	const body = await (await listApiKeys(new Request("https://mail.test/api/api-keys"))).json();
	assert.deepEqual(body.apiKeys.map((item) => item.id).sort(), ["general", "mixed"]);
});

const postKey = (body) =>
	createApiKey(new Request("https://mail.test/api/api-keys", { method: "POST", headers: { "Content-Type": "application/json", "Sec-Fetch-Site": "same-origin" }, body: JSON.stringify(body) }));
const keyBody = (scopes, extra = {}) => ({ name: "k", scopes, mailboxIds: ["m1"], ...extra });

test("an API key with the jmap scope needs the same step-up grant as an app password", async () => {
	setup();
	for (const scopes of [["jmap"], ["read", "jmap"], ["send", "jmap", "read"]]) {
		const missing = await postKey(keyBody(scopes));
		assert.equal(missing.status, 400, JSON.stringify(scopes));
		assert.equal((await missing.json()).code, "verification_required");
		const forged = await postKey(keyBody(scopes, { stepUpToken: "sup-not-a-real-grant" }));
		assert.equal(forged.status, 401);
		const wrongAction = await postKey(keyBody(scopes, { stepUpToken: await grant("passkey.add") }));
		assert.equal(wrongAction.status, 401);
	}
	assert.equal(keys().length, 0);
});

test("a valid grant creates the jmap key once; keys without jmap need none", async () => {
	setup();
	const token = await grant();
	const ok = await postKey(keyBody(["read", "jmap"], { stepUpToken: token }));
	assert.equal(ok.status, 200);
	assert.equal((await postKey(keyBody(["jmap"], { stepUpToken: token }))).status, 401, "single use");
	assert.equal((await postKey(keyBody(["read", "send"]))).status, 200);
	assert.equal(keys().length, 2);
});

test("a jmap key request that fails validation keeps the grant", async () => {
	setup();
	const token = await grant();
	assert.equal((await postKey(keyBody(["jmap"], { stepUpToken: token, mailboxIds: ["not-mine"] }))).status, 403);
	assert.equal((await postKey(keyBody(["jmap"], { stepUpToken: token, mailboxIds: [] }))).status, 400);
	assert.equal(unspentGrants(), 1);
	assert.equal(keys().length, 0);
});

test("a calendar-and-contacts password needs no mailbox, and only exists while DAV is enabled", async () => {
	setup();
	globalThis.appPwRoute.protocols = ["jmap", "dav"];
	const response = await post(valid(await grant(), { protocols: ["dav"], mailboxIds: [] }));
	assert.equal(response.status, 200);
	const [row] = keys();
	assert.equal(row.scopes, '["dav"]');
	assert.equal(row.mailbox_scope_enabled, 0);
	assert.equal(sqlite.prepare("SELECT count(*) AS n FROM mcp_key_mailboxes").get().n, 0);
	assert.deepEqual((await (await GET(new Request("https://mail.test/api/app-passwords"))).json()).availableProtocols, ["jmap", "dav"]);

	setup();
	const off = await post(valid(await grant(), { protocols: ["dav"], mailboxIds: [] }));
	assert.equal(off.status, 400);
	assert.equal(keys().length, 0);
});

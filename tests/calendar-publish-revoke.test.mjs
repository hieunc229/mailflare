import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test, { after } from "node:test";
import { installSqlite, loadFixture } from "./helpers/fixtures.mjs";

const { migrations } = JSON.parse(readFileSync(new URL("../src/lib/migrations/bundle.json", import.meta.url), "utf8"));
const schema = "PRAGMA foreign_keys = ON;\n" + migrations.flatMap((migration) => migration.statements).join(";\n");
const mocks = {
	"next/server": "export const NextResponse={json:(data,init)=>Response.json(data,init)};",
	"@/db": "export function getDb(){return globalThis.calPubRevoke.db}",
	"@/lib/cloudflare": "export function getEnv(){return {}}",
	"@/lib/auth/cookies": "export async function requireUser(){return globalThis.calPubRevoke.user}",
	"@/lib/mailboxes/access": "export async function getMailboxAccessLevel(){return null}",
	"@/lib/auth/session": "export function getSessionTokenFromRequestHeaders(){return null}",
	"@/lib/auth/webauthn/grants": "export async function consumeStepUpGrant(){return false}",
	"@/lib/http/auth-error": "export function authError(){return Response.json({},{status:401})}",
	"@/lib/mailboxes/audit": "export async function createAuditLog(env,input){globalThis.calPubRevoke.audit.push(input)}",
};
const fixture = await loadFixture({ name: "cal-pub-revoke", entryPoint: "src/app/api/api-keys/route.ts", mocks });
const { DELETE } = await fixture.import();
let sqlite;
after(() => { sqlite?.close(); delete globalThis.calPubRevoke; fixture.dispose(); });

function setup() {
	sqlite?.close();
	sqlite = installSqlite("calPubRevoke", { schema, extra: { user: { id: "u1" }, audit: [] } });
	for (const id of ["u1", "u2"]) sqlite.exec(`INSERT INTO users (id, email, name, password_hash, role, created_at) VALUES ('${id}', '${id}@one.test', 'U', 'x', 'user', 1)`);
	const key = (id, user, scopes, sha) => sqlite.exec(`INSERT INTO api_keys (id, user_id, name, prefix, key_hash, key_sha256, scopes, created_at) VALUES ('${id}', '${user}', 'k', 'ep_', 'x', '${sha.repeat(64).slice(0, 64)}', '${scopes}', 1)`);
	key("freebusy_u1", "u1", '["calendar:freebusy"]', "a");
	key("freebusy_u2", "u2", '["calendar:freebusy"]', "b");
	key("other", "u1", '["calendar:read"]', "c");
}
const del = (id) => DELETE(new Request(`https://m.test/api/api-keys?id=${id}`, { method: "DELETE", headers: { "Sec-Fetch-Site": "same-origin" } }));
const count = () => sqlite.prepare("SELECT count(*) AS n FROM api_keys").get().n;

test("deleting the publish key from Settings → API keys is audited like turning the link off", async () => {
	setup();
	assert.equal((await del("freebusy_u1")).status, 200);
	assert.equal(count(), 2);
	assert.deepEqual(globalThis.calPubRevoke.audit.map((entry) => [entry.action, entry.actorUserId, entry.targetUserId]), [["calendar.freebusy_unpublished", "u1", "u1"]]);
});

test("deleting any other key, or someone else's publish key, writes no such row", async () => {
	setup();
	assert.equal((await del("other")).status, 200);
	assert.equal((await del("freebusy_u2")).status, 404);
	assert.equal(count(), 2);
	assert.deepEqual(globalThis.calPubRevoke.audit, []);
});

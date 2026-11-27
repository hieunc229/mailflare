import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test, { after } from "node:test";
import { installSqlite, loadFixture } from "./helpers/fixtures.mjs";

const { migrations } = JSON.parse(readFileSync(new URL("../src/lib/migrations/bundle.json", import.meta.url), "utf8"));
const schema = "PRAGMA foreign_keys = ON;\n" + migrations.flatMap((migration) => migration.statements).join(";\n");
const mocks = {
	"next/server": "export const NextResponse={json:(data,init)=>Response.json(data,init)};",
	"@/db": "export function getDb(){return globalThis.calPubRevoke2.db}",
	"@/lib/cloudflare": "export function getEnv(){return {}}",
	"@/lib/auth/cookies": "export async function requireUser(){return globalThis.calPubRevoke2.user}",
	"@/lib/mailboxes/access": "export async function getMailboxAccessLevel(){return null}",
	"@/lib/auth/session": "export function getSessionTokenFromRequestHeaders(){return null}",
	"@/lib/auth/webauthn/grants": "export async function consumeStepUpGrant(){return false}",
	"@/lib/http/auth-error": "export function authError(){return Response.json({},{status:401})}",
	"@/lib/mailboxes/audit": "export async function createAuditLog(env,input){globalThis.calPubRevoke2.audit.push(input)}",
};
const fixture = await loadFixture({ name: "cal-pub-revoke2", entryPoint: "src/app/api/api-keys/route.ts", mocks });
const { DELETE } = await fixture.import();
let sqlite;
after(() => { sqlite?.close(); delete globalThis.calPubRevoke2; fixture.dispose(); });

let competing = false;
function setup() {
	sqlite?.close();
	competing = false;
	// The other request deletes the key between this one's lookup and its delete.
	sqlite = installSqlite("calPubRevoke2", { schema, extra: { user: { id: "u1" }, audit: [] }, beforeQuery: (sql, db) => { if (competing && /^delete from "api_keys"/i.test(sql)) { competing = false; db.exec("DELETE FROM api_keys WHERE id = 'freebusy_u1'"); } } });
	sqlite.exec("INSERT INTO users (id, email, name, password_hash, role, created_at) VALUES ('u1', 'u1@one.test', 'U', 'x', 'user', 1)");
	sqlite.exec(`INSERT INTO api_keys (id, user_id, name, prefix, key_hash, key_sha256, scopes, created_at) VALUES ('freebusy_u1', 'u1', 'k', 'ep_', 'x', '${"a".repeat(64)}', '["calendar:freebusy"]', 1)`);
}
const del = (id) => DELETE(new Request(`https://m.test/api/api-keys?id=${id}`, { method: "DELETE", headers: { "Sec-Fetch-Site": "same-origin" } }));

test("two deletes of the publish key at once write one audit row: the one whose delete removed nothing writes none", async () => {
	setup();
	competing = true;
	assert.equal((await del("freebusy_u1")).status, 200);
	assert.deepEqual(globalThis.calPubRevoke2.audit, []);
});

test("a delete that removes the key still writes its row", async () => {
	setup();
	assert.equal((await del("freebusy_u1")).status, 200);
	assert.equal(globalThis.calPubRevoke2.audit.length, 1);
});

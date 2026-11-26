import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test, { after } from "node:test";
import { installSqlite, loadFixture } from "./helpers/fixtures.mjs";

const { migrations } = JSON.parse(readFileSync(new URL("../src/lib/migrations/bundle.json", import.meta.url), "utf8"));
const schema = "PRAGMA foreign_keys = OFF;\n" + migrations.flatMap((migration) => migration.statements).join(";\n");

const mocks = {
	"@/db": "export function getDb(){return globalThis.adminGeneral.db}",
	"@/lib/cloudflare": "export function getEnv(){return {}}",
	"@/lib/api/auth": "export async function requireSessionUser(){const s=globalThis.adminGeneral;return s.user?{user:s.user,error:null}:{user:null,error:Response.json({error:'Unauthorized'},{status:401})}}",
	"@/lib/auth/admin": "export function isPrimaryAdmin(user){return user.admin===true}",
	"@/lib/auth/origin": "export function hasValidSessionMutationOrigin(){return true}",
	"@/lib/email/attachment-policy": "export const MAX_OUTBOUND_ATTACHMENT_MAX_MB=25; export async function getOutboundAttachmentMaxMb(){return 25} export function getOutboundAttachmentCeilingMb(){return 25}",
	"@/lib/drive/storage": "export async function getDriveStorageLimit(){return null}",
};
const fixture = await loadFixture({ name: "admin-general-dav", entryPoint: "src/app/api/admin/general/utils.ts", mocks });
const { GET, PUT } = await fixture.import();
let sqlite;
after(() => {
	sqlite?.close();
	delete globalThis.adminGeneral;
	fixture.dispose();
});

function setup(user = { id: "a", admin: true }) {
	sqlite?.close();
	sqlite = installSqlite("adminGeneral", { schema, extra: { user } });
}
const put = (body) => PUT(new Request("https://mail.test/api/admin/general", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }));
const enabled = () => sqlite.prepare("SELECT dav_enabled FROM app_settings WHERE id = 'default'").get()?.dav_enabled;

test("calendar and contacts sync is off until an administrator turns it on", async () => {
	setup();
	assert.equal((await (await GET(new Request("https://mail.test/api/admin/general"))).json()).davEnabled, false);
	const on = await put({ davEnabled: true });
	assert.equal(on.status, 200);
	assert.equal((await on.json()).davEnabled, true);
	assert.equal(enabled(), 1);
	assert.equal((await (await put({ davEnabled: false })).json()).davEnabled, false);
	assert.equal(enabled(), 0);
});

test("only the primary administrator can change it, and the value must be a boolean", async () => {
	setup({ id: "u", admin: false });
	assert.equal((await put({ davEnabled: true })).status, 403);
	setup();
	assert.equal((await put({ davEnabled: "yes" })).status, 400);
	assert.equal(enabled() ?? 0, 0);
});

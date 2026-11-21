import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadApp } from "./helpers/real-db.mjs";

const { app, newDatabase } = await loadApp("forwarding-reauth", `
	export { PATCH as patchAccount } from "./src/app/api/accounts/[id]/route.ts";
	export { PATCH as patchV1Account } from "./src/app/api/v1/accounts/[id]/route.ts";
	export { createSession } from "./src/lib/auth/session.ts";
	export { hashPassword } from "./src/lib/auth/password.ts";
	export { createStepUpGrant } from "./src/lib/auth/webauthn/grants.ts";
`, { mocks: {
	// The API-key path is exercised as the owner of the key (id from globalThis.keyOwner).
	"@/lib/api/admin-auth": "export async function authenticateAdminApiKey(){return {userId:globalThis.keyOwner,user:{id:globalThis.keyOwner,role:'admin',isPrimaryAdmin:true}}} export async function canManageAdminAccounts(){return true}",
} });

async function setup(t) {
	const fixture = await newDatabase(t, `
		INSERT INTO license_settings (id, instance_id, plan, state, updated_at) VALUES ('default', 'inst', 'team', 'active', 1);
	`);
	const hash = app.hashPassword("correct horse");
	fixture.sqlite.prepare("INSERT INTO users (id, email, password_hash, name, role, is_primary_admin, can_manage_users, created_at) VALUES ('admin', 'admin@example.com', ?, 'Admin', 'admin', 1, 1, 1)").run(hash);
	fixture.sqlite.prepare("INSERT INTO users (id, email, password_hash, name, role, created_by_user_id, created_at) VALUES ('member', 'member@example.com', ?, 'Member', 'user', 'admin', 1)").run(hash);
	globalThis.__mailflareNodeEnv = fixture.env;
	t.after(() => { delete globalThis.__mailflareNodeEnv; });
	const token = await app.createSession(fixture.env, "admin");
	const body = (extra) => ({ name: "Member", role: "user", disabled: false, canManageMailboxes: false, ...extra });
	const send = (handler, id, extra, headers = {}) => handler(new Request(`http://localhost/api/accounts/${id}`, {
		method: "PATCH",
		headers: { "content-type": "application/json", authorization: `Bearer ${token}`, ...headers },
		body: JSON.stringify(body(extra)),
	}), { params: Promise.resolve({ id }) });
	return { ...fixture, token, send };
}
const forwarding = (sqlite, id = "member") => sqlite.prepare("SELECT forwarding_email FROM users WHERE id = ?").get(id).forwarding_email;

test("an administrator needs fresh proof to set another account's forwarding address", async (t) => {
	const { send, sqlite, env, token } = await setup(t);
	assert.equal((await send(app.patchAccount, "member", { forwardingEmail: "spy@example.net" })).status, 401);
	assert.equal((await send(app.patchAccount, "member", { forwardingEmail: "spy@example.net", stepUpToken: "not-a-real-grant" })).status, 401);
	assert.equal(forwarding(sqlite), null);
	const grant = await app.createStepUpGrant(env, { userId: "admin", sessionToken: token, action: "admin.forwarding_email", targetUserId: "member", expectedActorSecurityVersion: 0 });
	const ok = await send(app.patchAccount, "member", { forwardingEmail: "ok@example.net", stepUpToken: grant });
	assert.equal(ok.status, 200);
	assert.equal(forwarding(sqlite), "ok@example.net");
});

test("a grant for another action does not authorise a forwarding change", async (t) => {
	const { send, sqlite, env, token } = await setup(t);
	const grant = await app.createStepUpGrant(env, { userId: "admin", sessionToken: token, action: "admin.password_reset", targetUserId: "member", expectedActorSecurityVersion: 0 });
	assert.equal((await send(app.patchAccount, "member", { forwardingEmail: "spy@example.net", stepUpToken: grant })).status, 401);
	assert.equal(forwarding(sqlite), null);
});

test("saving without changing the forwarding address needs no proof", async (t) => {
	const { send } = await setup(t);
	assert.equal((await send(app.patchAccount, "member", { name: "Member", forwardingEmail: null })).status, 200);
	assert.equal((await send(app.patchAccount, "member", {})).status, 200);
});

test("a password reset and a forwarding change are not accepted in one request", async (t) => {
	const { send, sqlite } = await setup(t);
	assert.equal((await send(app.patchAccount, "member", { forwardingEmail: "x@example.net", password: "new password 1", stepUpToken: "whatever-token" })).status, 400);
	assert.equal(forwarding(sqlite), null);
});

test("an API key may set a managed account's forwarding address but not its owner's own", async (t) => {
	const { send, sqlite } = await setup(t);
	globalThis.keyOwner = "admin";
	t.after(() => { delete globalThis.keyOwner; });
	assert.equal((await send(app.patchV1Account, "member", { forwardingEmail: "ok@example.net" })).status, 200);
	assert.equal(forwarding(sqlite), "ok@example.net");
	const own = await send(app.patchV1Account, "admin", { name: "Admin", role: "admin", forwardingEmail: "spy@example.net" });
	assert.equal(own.status, 403);
	assert.equal(forwarding(sqlite, "admin"), null);
});

test("the admin account page asks for the proof", () => {
	assert.match(readFileSync(new URL("../src/app/(admin)/accounts/[id]/page.tsx", import.meta.url), "utf8"), /action="admin\.forwarding_email"/);
});

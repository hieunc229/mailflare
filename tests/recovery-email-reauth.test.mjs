import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadApp } from "./helpers/real-db.mjs";

const { app, newDatabase } = await loadApp("recovery-email-reauth", `
	export { PATCH as patchProfile } from "./src/app/api/settings/profile/route.ts";
	export { PATCH as patchForwarding } from "./src/app/api/settings/forwarding/route.ts";
	export { createSession } from "./src/lib/auth/session.ts";
	export { hashPassword } from "./src/lib/auth/password.ts";
`);

async function setup(t) {
	const fixture = await newDatabase(t, `
		INSERT INTO license_settings (id, instance_id, plan, state, updated_at) VALUES ('default', 'inst', 'team', 'active', 1);
	`);
	fixture.sqlite.prepare("INSERT INTO users (id, email, password_hash, name, reset_email, created_at) VALUES ('u1', 'u1@example.com', ?, 'U One', 'old@example.org', 1)").run(app.hashPassword("correct horse"));
	globalThis.__mailflareNodeEnv = fixture.env;
	t.after(() => { delete globalThis.__mailflareNodeEnv; });
	const token = await app.createSession(fixture.env, "u1");
	const send = (handler, body) => handler(new Request("http://localhost/api/settings/x", {
		method: "PATCH",
		headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
		body: JSON.stringify(body),
	}));
	return { ...fixture, send };
}
const row = (sqlite) => ({ ...sqlite.prepare("SELECT reset_email, forwarding_email FROM users WHERE id = 'u1'").get() });

test("changing the recovery email needs the password or a step-up grant", async (t) => {
	const { send, sqlite } = await setup(t);
	assert.equal((await send(app.patchProfile, { name: "U One", resetEmail: "attacker@example.net" })).status, 401);
	assert.equal((await send(app.patchProfile, { name: "U One", resetEmail: "attacker@example.net", password: "wrong" })).status, 401);
	assert.equal((await send(app.patchProfile, { name: "U One", resetEmail: "attacker@example.net", stepUpToken: "not-a-real-grant" })).status, 401);
	assert.equal(row(sqlite).reset_email, "old@example.org");

	const ok = await send(app.patchProfile, { name: "U One", resetEmail: "new@example.org", password: "correct horse" });
	assert.equal(ok.status, 200);
	assert.equal(row(sqlite).reset_email, "new@example.org");
});

test("saving the profile without changing the recovery email needs no proof", async (t) => {
	const { send } = await setup(t);
	assert.equal((await send(app.patchProfile, { name: "Renamed", resetEmail: "old@example.org" })).status, 200);
});

test("setting a forwarding address needs the password or a step-up grant", async (t) => {
	const { send, sqlite } = await setup(t);
	assert.equal((await send(app.patchForwarding, { forwardingEmail: "spy@example.net" })).status, 401);
	assert.equal((await send(app.patchProfile, { name: "U One", resetEmail: "old@example.org", forwardingEmail: "spy@example.net" })).status, 401);
	assert.equal(row(sqlite).forwarding_email, null);
	assert.equal((await send(app.patchForwarding, { forwardingEmail: "me@example.net", password: "correct horse" })).status, 200);
	assert.equal(row(sqlite).forwarding_email, "me@example.net");
});

test("both routes refuse cross-site cookie requests and the form asks for the proof", () => {
	for (const file of ["src/app/api/settings/profile/route.ts", "src/app/api/settings/forwarding/route.ts"]) {
		assert.match(readFileSync(new URL(`../${file}`, import.meta.url), "utf8"), /hasValidSessionMutationOrigin\(request\)/, file);
	}
	assert.match(readFileSync(new URL("../src/components/settings/profile-form.tsx", import.meta.url), "utf8"), /action="profile\.recovery_email"/);
});

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadApp } from "./helpers/real-db.mjs";

const { app, newDatabase } = await loadApp("webhook-reauth", `
	export { POST as createWebhook } from "./src/app/api/webhooks/route.ts";
	export { PATCH as patchWebhook } from "./src/app/api/webhooks/[id]/route.ts";
	export { createSession } from "./src/lib/auth/session.ts";
	export { hashPassword } from "./src/lib/auth/password.ts";
	export { createStepUpGrant } from "./src/lib/auth/webauthn/grants.ts";
`);

async function setup(t) {
	const fixture = await newDatabase(t);
	fixture.sqlite.prepare("INSERT INTO users (id, email, password_hash, name, role, is_primary_admin, created_at) VALUES ('u1', 'u1@example.com', ?, 'U One', 'admin', 1, 1)").run(app.hashPassword("correct horse"));
	globalThis.__mailflareNodeEnv = fixture.env;
	t.after(() => { delete globalThis.__mailflareNodeEnv; });
	const token = await app.createSession(fixture.env, "u1");
	const send = (handler, body, id = "x", method = "POST") => handler(new Request("http://localhost/api/webhooks", {
		method, headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify(body),
	}), { params: Promise.resolve({ id }) });
	return { ...fixture, token, send };
}
const hook = (extra) => ({ url: "https://hooks.example.net/in", events: ["message.inbound"], ...extra });
const rows = (sqlite) => sqlite.prepare("SELECT id, url, events, enabled, max_attempts FROM webhooks").all();

test("creating a webhook needs the password or a step-up grant", async (t) => {
	const { send, sqlite, env, token } = await setup(t);
	assert.equal((await send(app.createWebhook, hook())).status, 401);
	assert.equal((await send(app.createWebhook, hook({ password: "wrong" }))).status, 401);
	assert.equal((await send(app.createWebhook, hook({ stepUpToken: "not-a-real-grant" }))).status, 401);
	assert.equal(rows(sqlite).length, 0);
	assert.equal((await send(app.createWebhook, hook({ password: "correct horse" }))).status, 200);
	const grant = await app.createStepUpGrant(env, { userId: "u1", sessionToken: token, action: "webhook.change", expectedActorSecurityVersion: 0 });
	assert.equal((await send(app.createWebhook, hook({ stepUpToken: grant }))).status, 200);
	assert.equal(rows(sqlite).length, 2);
});

test("a grant for another action does not authorise a webhook", async (t) => {
	const { send, sqlite, env, token } = await setup(t);
	const grant = await app.createStepUpGrant(env, { userId: "u1", sessionToken: token, action: "routing.forward", expectedActorSecurityVersion: 0 });
	assert.equal((await send(app.createWebhook, hook({ stepUpToken: grant }))).status, 401);
	assert.equal(rows(sqlite).length, 0);
});

test("changing the URL or adding events needs proof, other edits and existing hooks do not", async (t) => {
	const { send, sqlite } = await setup(t);
	// A webhook created before this check existed.
	sqlite.exec("INSERT INTO webhooks (id, user_id, url, secret, events, enabled, max_attempts, created_at) VALUES ('wh1', 'u1', 'https://old.example.net/in', 's', '[\"message.inbound\"]', 1, 5, 1)");
	const patch = (body) => send(app.patchWebhook, body, "wh1", "PATCH");
	assert.equal((await patch({ enabled: false })).status, 200);
	assert.equal((await patch({ maxAttempts: 3, description: "x" })).status, 200);
	assert.equal((await patch({ rotateSecret: true })).status, 200);
	assert.equal((await patch({ url: "https://old.example.net/in", events: ["message.inbound"] })).status, 200, "unchanged values need no proof");
	assert.equal((await patch({ url: "https://spy.example.net/in" })).status, 401);
	assert.equal((await patch({ events: ["message.inbound", "message.outbound"] })).status, 401);
	assert.equal(rows(sqlite)[0].url, "https://old.example.net/in");
	assert.equal((await patch({ url: "https://new.example.net/in", password: "correct horse" })).status, 200);
	assert.equal(rows(sqlite)[0].url, "https://new.example.net/in");
});

test("switching a disabled webhook back on needs proof, switching it off does not", async (t) => {
	const { send, sqlite } = await setup(t);
	sqlite.exec("INSERT INTO webhooks (id, user_id, url, secret, events, enabled, max_attempts, created_at) VALUES ('wh1', 'u1', 'https://old.example.net/in', 's', '[\"message.inbound\"]', 1, 5, 1)");
	const patch = (body) => send(app.patchWebhook, body, "wh1", "PATCH");
	assert.equal((await patch({ enabled: false })).status, 200);
	assert.equal((await patch({ enabled: false })).status, 200, "staying off needs no proof");
	assert.equal((await patch({ enabled: true })).status, 401);
	assert.equal(rows(sqlite)[0].enabled, 0);
	assert.equal((await patch({ enabled: true, password: "correct horse" })).status, 200);
	assert.equal(rows(sqlite)[0].enabled, 1);
	assert.equal((await patch({ enabled: true })).status, 200, "staying on needs no proof");
});

test("the webhooks page opens the step-up dialog and never redirects on the 401", () => {
	const page = readFileSync(new URL("../src/app/(admin)/webhooks/page.tsx", import.meta.url), "utf8");
	assert.match(page, /action="webhook\.change"/);
	assert.match(page, /passwordSet \?\? true/);
	const utils = readFileSync(new URL("../src/app/(admin)/webhooks/utils.ts", import.meta.url), "utf8");
	assert.match(utils, /"\/api\/webhooks", \{\s*method: "POST",[^}]*redirectOnUnauthorized: false/);
	assert.match(utils, /`\/api\/webhooks\/\$\{id\}`, \{\s*method: "PATCH",[^}]*redirectOnUnauthorized: false/);
});

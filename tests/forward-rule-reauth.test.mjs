import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadApp } from "./helpers/real-db.mjs";

const { app, newDatabase } = await loadApp("forward-rule-reauth", `
	export { POST as createMailboxRule } from "./src/app/api/routing-rules/route.ts";
	export { PATCH as patchMailboxRule } from "./src/app/api/routing-rules/[id]/route.ts";
	export { POST as createDomainRule } from "./src/app/api/routing-rules/domain/route.ts";
	export { PATCH as patchDomainRule } from "./src/app/api/routing-rules/domain/[id]/route.ts";
	export { createSession } from "./src/lib/auth/session.ts";
	export { hashPassword } from "./src/lib/auth/password.ts";
`);

async function setup(t) {
	const fixture = await newDatabase(t, `
		INSERT INTO license_settings (id, instance_id, plan, state, updated_at) VALUES ('default', 'inst', 'team', 'active', 1);
	`);
	fixture.sqlite.prepare("INSERT INTO users (id, email, password_hash, name, role, is_primary_admin, created_at) VALUES ('u1', 'u1@example.com', ?, 'U One', 'admin', 1, 1)").run(app.hashPassword("correct horse"));
	fixture.sqlite.exec(`
		INSERT INTO domains (id, user_id, hostname, zone_id, status, created_at) VALUES ('d1', 'u1', 'example.com', 'z', 'active', 1);
		INSERT INTO mailboxes (id, user_id, domain_id, local_part, type, created_at) VALUES ('mb1', 'u1', 'd1', 'u1', 'personal', 1), ('mb2', 'u1', 'd1', 'sales', 'personal', 1);
	`);
	globalThis.__mailflareNodeEnv = fixture.env;
	t.after(() => { delete globalThis.__mailflareNodeEnv; });
	const token = await app.createSession(fixture.env, "u1");
	const send = (handler, body, id = "x", method = "POST") => handler(new Request("http://localhost/api/routing-rules", {
		method, headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify(body),
	}), { params: Promise.resolve({ id }) });
	return { ...fixture, send };
}
const mailboxRule = (extra) => ({ mailboxId: "mb1", matchField: "email", matchOperator: "contains", matchValue: "news", destination: "forward", priority: 1, ...extra });
const domainRule = (extra) => ({ domainId: "d1", matchValue: "*", action: "forward", priority: 1, ...extra });
const count = (sqlite) => sqlite.prepare("SELECT count(*) AS n FROM routing_rules").get().n;

test("a forward rule to an outside address needs the password or a step-up grant", async (t) => {
	const { send, sqlite } = await setup(t);
	assert.equal((await send(app.createMailboxRule, mailboxRule({ forwardTo: "spy@example.net" }))).status, 401);
	assert.equal((await send(app.createDomainRule, domainRule({ forwardTo: "spy@example.net" }))).status, 401);
	assert.equal((await send(app.createMailboxRule, mailboxRule({ forwardTo: "spy@example.net", password: "wrong" }))).status, 401);
	assert.equal(count(sqlite), 0);
	assert.equal((await send(app.createMailboxRule, mailboxRule({ forwardTo: "me@example.net", password: "correct horse" }))).status, 200);
	assert.equal((await send(app.createDomainRule, domainRule({ forwardTo: "me@example.net", password: "correct horse" }))).status, 200);
	assert.equal(count(sqlite), 2);
});

test("forwarding to the user's own mailbox or alias needs no proof, an unclaimed address on their domain does", async (t) => {
	const { send, sqlite } = await setup(t);
	sqlite.exec("INSERT INTO mailbox_aliases (id, domain_id, mailbox_id, local_part, created_at) VALUES ('al1', 'd1', 'mb2', 'info', 1)");
	assert.equal((await send(app.createMailboxRule, mailboxRule({ forwardTo: "sales@example.com" }))).status, 200);
	assert.equal((await send(app.createDomainRule, domainRule({ forwardTo: "info@example.com" }))).status, 200);
	assert.equal(count(sqlite), 2);
	// No mailbox or alias answers to this address, so a catch-all or a later rule could send it anywhere.
	assert.equal((await send(app.createDomainRule, domainRule({ forwardTo: "anyone@example.com" }))).status, 401);
	assert.equal(count(sqlite), 2);
});

test("widening an existing outside forward needs proof, as does changing any match criterion", async (t) => {
	const { send, sqlite } = await setup(t);
	const created = await (await send(app.createMailboxRule, mailboxRule({ forwardTo: "me@example.net", password: "correct horse" }))).json();
	for (const widened of [{ matchValue: "n" }, { matchOperator: "exact" }, { matchField: "title" }]) {
		assert.equal((await send(app.patchMailboxRule, mailboxRule({ forwardTo: "me@example.net", ...widened }), created.id, "PATCH")).status, 401, JSON.stringify(widened));
	}
	assert.equal(sqlite.prepare("SELECT match_value FROM routing_rules WHERE id = ?").get(created.id).match_value, "news");
	assert.equal((await send(app.patchMailboxRule, mailboxRule({ forwardTo: "me@example.net", matchValue: "n", password: "correct horse" }), created.id, "PATCH")).status, 200);

	const domain = await (await send(app.createDomainRule, domainRule({ matchValue: "sales", forwardTo: "me@example.net", password: "correct horse" }))).json();
	assert.equal((await send(app.patchDomainRule, domainRule({ matchValue: "*", forwardTo: "me@example.net" }), domain.id, "PATCH")).status, 401);
	assert.equal((await send(app.patchDomainRule, domainRule({ matchValue: "*", forwardTo: "me@example.net", password: "correct horse" }), domain.id, "PATCH")).status, 200);
});

test("retargeting a rule to an outside address needs proof, resaving it unchanged does not", async (t) => {
	const { send, sqlite } = await setup(t);
	const created = await (await send(app.createMailboxRule, mailboxRule({ forwardTo: "me@example.net", password: "correct horse" }))).json();
	assert.equal((await send(app.patchMailboxRule, mailboxRule({ forwardTo: "me@example.net", priority: 2 }), created.id, "PATCH")).status, 200);
	assert.equal((await send(app.patchMailboxRule, mailboxRule({ forwardTo: "spy@example.net" }), created.id, "PATCH")).status, 401);
	assert.equal(sqlite.prepare("SELECT forward_to FROM routing_rules WHERE id = ?").get(created.id).forward_to, "me@example.net");
	const store = await (await send(app.createMailboxRule, mailboxRule({ destination: "trash" }))).json();
	assert.equal((await send(app.patchMailboxRule, mailboxRule({ forwardTo: "spy@example.net" }), store.id, "PATCH")).status, 401);

	const domain = await (await send(app.createDomainRule, domainRule({ forwardTo: "me@example.net", password: "correct horse" }))).json();
	assert.equal((await send(app.patchDomainRule, domainRule({ forwardTo: "spy@example.net" }), domain.id, "PATCH")).status, 401);
	assert.equal((await send(app.patchDomainRule, domainRule({ forwardTo: "me@example.net", enabled: false }), domain.id, "PATCH")).status, 200);
});

test("re-enabling a disabled outside forward, or changing its copy mailbox, needs proof", async (t) => {
	const { send, sqlite } = await setup(t);
	const rule = (extra) => domainRule({ forwardTo: "me@example.net", keepCopy: true, mailboxId: "mb1", ...extra });
	const created = await (await send(app.createDomainRule, rule({ password: "correct horse" }))).json();
	const state = () => sqlite.prepare("SELECT enabled, mailbox_id FROM routing_rules WHERE id = ?").get(created.id);
	// Switching a forward off never needs proof.
	assert.equal((await send(app.patchDomainRule, rule({ enabled: false }), created.id, "PATCH")).status, 200);
	assert.equal((await send(app.patchDomainRule, rule({ enabled: true }), created.id, "PATCH")).status, 401);
	assert.equal(state().enabled, 0);
	assert.equal((await send(app.patchDomainRule, rule({ enabled: true, password: "correct horse" }), created.id, "PATCH")).status, 200);
	assert.equal(state().enabled, 1);
	// The copy target is part of where the mail ends up.
	assert.equal((await send(app.patchDomainRule, rule({ mailboxId: "mb2" }), created.id, "PATCH")).status, 401);
	assert.equal(state().mailbox_id, "mb1");
	assert.equal((await send(app.patchDomainRule, rule({ mailboxId: "mb2", password: "correct horse" }), created.id, "PATCH")).status, 200);
	assert.equal(state().mailbox_id, "mb2");
	// A rule that stays enabled with the same copy mailbox is a plain re-save.
	assert.equal((await send(app.patchDomainRule, rule({ mailboxId: "mb2", priority: 5 }), created.id, "PATCH")).status, 200);
});

test("the rule screens open the step-up dialog", () => {
	for (const file of ["src/components/settings/inbox-rules.tsx", "src/components/settings/domain-routing/domain-routing.tsx"]) {
		assert.match(readFileSync(new URL(`../${file}`, import.meta.url), "utf8"), /action="routing\.forward"/, file);
	}
});

test("a missing or refused proof is a 401 the screens handle, never a redirect to sign-in", () => {
	for (const file of ["src/components/settings/inbox-rules-utils.ts", "src/components/settings/domain-routing/utils.ts"]) {
		const source = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
		for (const call of source.matchAll(/authFetch\([^)]*?\{\s*method: "(POST|PATCH)"[\s\S]*?\}\)/g)) {
			assert.match(call[0], /redirectOnUnauthorized: false/, `${file} ${call[1]}`);
		}
	}
	for (const file of ["src/components/settings/inbox-rules.tsx", "src/components/settings/domain-routing/domain-routing.tsx"]) {
		assert.match(readFileSync(new URL(`../${file}`, import.meta.url), "utf8"), /passwordSet \?\? true/, file);
	}
});

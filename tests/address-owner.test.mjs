import assert from "node:assert/strict";
import test from "node:test";
import { loadApp } from "./helpers/real-db.mjs";

const mocks = {
	"next/server": "export const NextResponse={json:(data,init)=>Response.json(data,init)};",
	"@/lib/cloudflare": "export function getEnv(){return globalThis.ownerEnv}",
	"@/lib/auth/cookies": "export async function requireUser(){return globalThis.ownerUser}",
	"@/lib/api/admin-auth": "export async function authenticateAdminApiKey(){return {userId:'admin'}} export async function canShareAdminMailboxes(){return true}",
	"@/lib/cloudflare-api": "export async function ensureEmailRoutingRuleToWorker(){} export async function deleteEmailRoutingRuleForAddress(){} export async function rollbackEmailRoutingRuleChanges(){}",
	"@/lib/mailboxes/settings-access": "export async function getMailboxSettingsAccess(){return {canManage:true}}",
	"@/lib/auth/password": "export function hashPassword(){return 'hash'}",
	"@/lib/booking/username": "export async function ensureBookingUsername(){}",
};

const { app, newDatabase } = await loadApp("address-owner", `
	export { findAddressOwner } from "./src/lib/mailboxes/address-owner.ts";
	export * as mailboxesRoute from "./src/app/api/mailboxes/route.ts";
	export * as v1Mailboxes from "./src/app/api/v1/mailboxes/route.ts";
	export * as aliasesRoute from "./src/app/api/mailboxes/[id]/aliases/route.ts";
	export { createAccountResponse } from "./src/app/api/accounts/create.ts";
	export { ensurePersonalMailbox } from "./src/app/api/mailboxes/utils.ts";
`, { mocks });

const seed = `
	INSERT INTO users (id, email, password_hash, name, role, created_at) VALUES
		('admin', 'admin@example.com', 'hash', 'Admin', 'admin', 1),
		('u2', 'sam@example.com', 'hash', 'Sam', 'user', 1);
	INSERT INTO domains (id, user_id, hostname, zone_id, status, receiving_provider, created_at) VALUES
		('d1', 'admin', 'example.com', 'z1', 'active', 'cloudflare', 1),
		('d2', 'admin', 'other.com', 'z2', 'active', 'cloudflare', 1);
	INSERT INTO mailboxes (id, user_id, domain_id, local_part, type, use_all_domains, created_at) VALUES
		('m-admin', 'admin', 'd1', 'admin', 'personal', 0, 1),
		('m-sales', 'admin', 'd1', 'sales', 'shared', 0, 1),
		('m-all', 'admin', 'd1', 'everywhere', 'personal', 1, 1);
	INSERT INTO mailbox_aliases (id, mailbox_id, domain_id, local_part, enabled, masked, created_at) VALUES
		('a1', 'm-admin', 'd1', 'billing', 1, 0, 1);
`;

async function ctx(t) {
	const database = await newDatabase(t, seed);
	globalThis.ownerEnv = database.env;
	globalThis.ownerUser = { id: "admin", role: "admin", email: "admin@example.com", canManageMailboxes: true, createdByUserId: null };
	return database;
}

const post = (body) => new Request("https://x.test/api", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const idParams = (id) => ({ params: Promise.resolve({ id }) });

test("findAddressOwner reports mailbox, alias, or nothing, on normalized local parts", async (t) => {
	const { db } = await ctx(t);
	assert.equal(await app.findAddressOwner(db, "d1", "sales"), "mailbox");
	assert.equal(await app.findAddressOwner(db, "d1", "s.ales+tag"), "mailbox");
	assert.equal(await app.findAddressOwner(db, "d1", "Billing"), "alias");
	assert.equal(await app.findAddressOwner(db, "d1", "nobody"), null);
	assert.equal(await app.findAddressOwner(db, "d2", "sales"), null);
});

test("findAddressOwner treats a use-all-domains mailbox as the owner only when asked", async (t) => {
	const { db } = await ctx(t);
	assert.equal(await app.findAddressOwner(db, "d2", "everywhere"), null);
	assert.equal(await app.findAddressOwner(db, "d2", "everywhere", { allDomains: { exceptMailboxId: "m-admin" } }), "mailbox");
	assert.equal(await app.findAddressOwner(db, "d2", "everywhere", { allDomains: { exceptMailboxId: "m-all" } }), null);
});

test("POST /api/mailboxes pins its 409 messages", async (t) => {
	await ctx(t);
	for (const [localPart, message] of [
		["s.ales", "Mailbox already exists"],
		["billing", "An alias already uses this address"],
	]) {
		const res = await app.mailboxesRoute.POST(post({ domainId: "d1", localPart }));
		assert.equal(res.status, 409, localPart);
		assert.deepEqual(await res.json(), { error: message });
	}
	const ok = await app.mailboxesRoute.POST(post({ domainId: "d1", localPart: "fresh" }));
	assert.equal(ok.status, 200);
});

test("POST /api/v1/mailboxes pins its 409 messages", async (t) => {
	await ctx(t);
	for (const [localPart, message] of [
		["s.ales", "Mailbox already exists"],
		["billing", "An alias already uses this address"],
	]) {
		const res = await app.v1Mailboxes.POST(post({ domainId: "d1", localPart }));
		assert.equal(res.status, 409, localPart);
		assert.deepEqual(await res.json(), { error: message });
	}
	assert.equal((await app.v1Mailboxes.POST(post({ domainId: "d1", localPart: "fresh" }))).status, 201);
});

test("POST /api/mailboxes/[id]/aliases pins its 409 messages", async (t) => {
	await ctx(t);
	const call = (localPart, domainId = "d1") => app.aliasesRoute.POST(post({ domainId, localPart }), idParams("m-admin"));
	const mailbox = await call("sales");
	assert.equal(mailbox.status, 409);
	assert.deepEqual(await mailbox.json(), { error: "A mailbox already uses this address" });
	// Another mailbox receives this address through "Use all domains".
	const allDomains = await call("everywhere", "d2");
	assert.equal(allDomains.status, 409);
	assert.deepEqual(await allDomains.json(), { error: "A mailbox already uses this address" });
	const alias = await call("bill.ing");
	assert.equal(alias.status, 409);
	assert.deepEqual(await alias.json(), { error: "An alias already uses this address" });
	assert.equal((await call("fresh")).status, 200);
});

test("account creation pins its 409 message for a taken primary or alias address", async (t) => {
	await ctx(t);
	const actor = { id: "admin", canManageMailboxes: true, createdByUserId: null };
	const input = (username, aliases = []) => ({ username, password: "pw-long-enough-1", role: "user", domainId: "d1", aliases, useAllDomains: false });
	const message = "An email address is already assigned to a mailbox or alias";
	for (const body of [input("s.ales"), input("billing"), input("newbie", [{ domainId: "d1", localPart: "sales" }])]) {
		const res = await app.createAccountResponse(globalThis.ownerEnv, actor, body);
		assert.equal(res.status, 409, JSON.stringify(body));
		assert.deepEqual(await res.json(), { error: message });
	}
});

test("ensurePersonalMailbox leaves an address that an alias already owns alone", async (t) => {
	const { db, sqlite } = await ctx(t);
	sqlite.exec(`INSERT INTO users (id, email, password_hash, name, role, created_at) VALUES ('u3', 'billing@example.com', 'h', 'Bill', 'user', 1)`);
	await app.ensurePersonalMailbox(globalThis.ownerEnv, db, { id: "u3", email: "billing@example.com", name: "Bill", role: "user" });
	assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM mailboxes WHERE user_id = 'u3'").get().n, 0);
});

test("every address route refuses an address a group already uses", async (t) => {
	const { sqlite } = await ctx(t);
	sqlite.exec("INSERT INTO mail_groups (id, domain_id, local_part, name, created_at, updated_at) VALUES ('g1', 'd1', 'team', 'Team', 1, 1)");
	const expected = { error: "A group already uses this address" };
	for (const [label, response] of [
		["mailboxes", await app.mailboxesRoute.POST(post({ domainId: "d1", localPart: "te.am" }))],
		["v1 mailboxes", await app.v1Mailboxes.POST(post({ domainId: "d1", localPart: "team" }))],
		["aliases", await app.aliasesRoute.POST(post({ domainId: "d1", localPart: "team" }), idParams("m-admin"))],
	]) {
		assert.equal(response.status, 409, label);
		assert.deepEqual(await response.json(), expected, label);
	}
	const actor = { id: "admin", canManageMailboxes: true, createdByUserId: null };
	const account = await app.createAccountResponse(globalThis.ownerEnv, actor, { username: "team", password: "pw-long-enough-1", role: "user", domainId: "d1", aliases: [], useAllDomains: false });
	assert.equal(account.status, 409);
	assert.deepEqual(await account.json(), expected);
});

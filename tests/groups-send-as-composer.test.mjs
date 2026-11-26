import assert from "node:assert/strict";
import test from "node:test";
import { loadApp } from "./helpers/real-db.mjs";

const mocks = {
	"next/server": "export const NextResponse={json:(data,init)=>Response.json(data,init)};",
	"@/lib/cloudflare": "export function getEnv(){return globalThis.cmp.env}",
	"@/lib/auth/cookies": "export async function requireUser(){return globalThis.cmp.user}",
	"@/lib/deliverability/report-address": "export async function isReportAddressReserved(){return false}",
	"@/lib/cloudflare-api": "export async function ensureEmailRoutingRuleToWorker(){} export async function deleteEmailRoutingRuleForAddress(){return true}",
};
const { app, newDatabase } = await loadApp("groups-send-as-composer", `
	export * as mailboxes from "./src/app/api/mailboxes/route.ts";
`, { mocks });

const seed = (plan = "team") => `
	INSERT INTO users (id, email, password_hash, name, role, created_at) VALUES
		('admin', 'admin@example.com', 'hash', 'Admin', 'admin', 1),
		('alice', 'alice@example.com', 'hash', 'Alice Doe', 'user', 1),
		('bob', 'bob@example.com', 'hash', 'Bob', 'user', 1);
	INSERT INTO domains (id, user_id, hostname, zone_id, status, created_at) VALUES ('d1', 'admin', 'example.com', 'z1', 'active', 1), ('d2', 'admin', 'other.com', 'z2', 'active', 1);
	INSERT INTO mailboxes (id, user_id, domain_id, local_part, type, created_at) VALUES
		('m-alice', 'alice', 'd1', 'alice', 'personal', 1),
		('m-alice2', 'alice', 'd1', 'desk', 'personal', 1),
		('m-bob', 'bob', 'd1', 'bob', 'personal', 1),
		('m-shared', 'admin', 'd1', 'support', 'shared', 1);
	INSERT INTO mailbox_access (id, mailbox_id, user_id, permission, created_at) VALUES ('acc-1', 'm-shared', 'alice', 'send_as', 1);
	INSERT INTO license_settings (id, instance_id, plan, state, updated_at) VALUES ('default', 'inst', '${plan}', 'active', 1);
	INSERT INTO mail_groups (id, domain_id, local_part, name, disabled, created_at, updated_at) VALUES
		('g1', 'd1', 'team', 'Team', 0, 1, 1), ('g2', 'd2', 'sales', 'Sales', 0, 1, 1), ('g3', 'd1', 'paused', 'Paused', 1, 1, 1), ('g4', 'd1', 'nope', 'Nope', 0, 1, 1);
	INSERT INTO mail_group_members (id, group_id, kind, user_id, can_send_as, created_at) VALUES
		('a', 'g1', 'user', 'alice', 1, 1), ('b', 'g2', 'user', 'alice', 1, 1), ('c', 'g3', 'user', 'alice', 1, 1), ('d', 'g4', 'user', 'alice', 0, 1), ('e', 'g1', 'user', 'bob', 0, 1);
`;
const userOf = (id) => ({ id, email: `${id}@example.com`, name: id, role: "user" });
async function list(t, userId, plan) {
	const database = await newDatabase(t, seed(plan));
	globalThis.cmp = { env: database.env, user: userOf(userId) };
	t.after(() => { delete globalThis.cmp; });
	const body = await (await app.mailboxes.GET(new Request("https://x.test/api/mailboxes"))).json();
	return Object.fromEntries(body.mailboxes.map((mailbox) => [mailbox.id, mailbox.senderAddresses]));
}

test("the From list of the primary mailbox adds each enabled group the member may send as", async (t) => {
	const lists = await list(t, "alice");
	assert.deepEqual(lists["m-alice"].slice(-2), ["sales@other.com", "team@example.com"]);
	assert.ok(lists["m-alice"].includes("alice@example.com"));
	assert.ok(!lists["m-alice"].some((a) => /paused|nope/.test(a)), "disabled group and unflagged group are left out");
});

test("other mailboxes of the account and shared mailboxes list no group address", async (t) => {
	const lists = await list(t, "alice");
	for (const id of ["m-alice2", "m-shared"]) assert.ok(!lists[id].some((a) => /team|sales/.test(a)), id);
});

test("a member without the flag sees no group, and neither does anyone without the licence", async (t) => {
	assert.ok(!(await list(t, "bob"))["m-bob"].some((a) => /team/.test(a)));
	assert.ok(!(await list(t, "alice", "free"))["m-alice"].some((a) => /team|sales/.test(a)));
});

test("the mailbox list names which sender addresses are groups, so replies can default to the personal one", async (t) => {
	const database = await newDatabase(t, seed());
	globalThis.cmp = { env: database.env, user: userOf("alice") };
	t.after(() => { delete globalThis.cmp; });
	const body = await (await app.mailboxes.GET(new Request("https://x.test/api/mailboxes"))).json();
	const byId = Object.fromEntries(body.mailboxes.map((mailbox) => [mailbox.id, mailbox]));
	assert.deepEqual(byId["m-alice"].groupSenderAddresses, ["sales@other.com", "team@example.com"]);
	assert.deepEqual(byId["m-alice2"].groupSenderAddresses, []);
	assert.deepEqual(byId["m-shared"].groupSenderAddresses, []);
});

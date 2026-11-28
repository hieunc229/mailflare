import assert from "node:assert/strict";
import test from "node:test";
import { loadApp } from "./helpers/real-db.mjs";

const { app, newDatabase } = await loadApp("realtime-hub", `
	export { getUserMailRevision } from "./src/lib/realtime/revision.ts";
	export { RealtimeHub } from "./src/lib/realtime/hub.ts";
`, { mocks: { "cloudflare:workers": "export class DurableObject {}" } });

const seed = (t) => newDatabase(t, `
	INSERT INTO users (id, email, password_hash, name, role, created_at) VALUES
		('owner', 'owner@example.com', 'x', 'Owner', 'user', 1),
		('delegate', 'delegate@example.com', 'x', 'Delegate', 'user', 1),
		('nobody', 'nobody@example.com', 'x', 'Nobody', 'user', 1);
	INSERT INTO domains (id, user_id, hostname, zone_id, status, created_at) VALUES ('d1', 'owner', 'example.com', 'z', 'active', 1);
	INSERT INTO mailboxes (id, user_id, domain_id, local_part, type, disabled, created_at) VALUES
		('mb-owner', 'owner', 'd1', 'owner', 'personal', 0, 1),
		('mb-off', 'owner', 'd1', 'off', 'personal', 1, 1),
		('mb-team', 'owner', 'd1', 'team', 'shared', 0, 1);
	INSERT INTO mailbox_access (id, mailbox_id, user_id, permission, created_at) VALUES ('acc-1', 'mb-team', 'delegate', 'read_only', 1);
	INSERT INTO jmap_mailbox_revisions (mailbox_id, revision) VALUES ('mb-team', 7);
`);

test("a delegate's revision covers the shared mailbox with their permission and nothing else", async (t) => {
	const { env } = await seed(t);
	assert.deepEqual(JSON.parse(await app.getUserMailRevision(env, "delegate")), [["mb-team", 7, "read_only"]]);
});

test("an owner's revision lists enabled mailboxes and skips disabled ones", async (t) => {
	const { env } = await seed(t);
	assert.deepEqual(JSON.parse(await app.getUserMailRevision(env, "owner")), [["mb-owner", 0, "owner"], ["mb-team", 7, "owner"]]);
});

test("a user with no mailboxes gets an empty revision", async (t) => {
	const { env } = await seed(t);
	assert.equal(await app.getUserMailRevision(env, "nobody"), "[]");
});

function hubFor(env) {
	const hub = Object.create(app.RealtimeHub.prototype);
	hub.env = env;
	const sent = [];
	const socket = { deserializeAttachment: () => ({ userId: "delegate" }), send: (message) => sent.push(message), close() {} };
	return { hub, socket, sent };
}

test("a ping with a stale revision reports a change, and with the current one does not", async (t) => {
	const { env } = await seed(t);
	const { hub, socket, sent } = hubFor(env);
	const current = await app.getUserMailRevision(env, "delegate");
	await hub.webSocketMessage(socket, JSON.stringify({ type: "ping", revision: "stale" }));
	await hub.webSocketMessage(socket, JSON.stringify({ type: "ping", revision: current }));
	assert.deepEqual(sent.map((message) => JSON.parse(message)), [
		{ type: "revision", revision: current, changed: true },
		{ type: "revision", revision: current, changed: false },
	]);
});

test("a plain ping string is answered with pong", async (t) => {
	const { env } = await seed(t);
	const { hub, socket, sent } = hubFor(env);
	await hub.webSocketMessage(socket, "ping");
	assert.deepEqual(sent, ["pong"]);
});

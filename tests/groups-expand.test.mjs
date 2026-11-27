import assert from "node:assert/strict";
import test from "node:test";
import { loadApp } from "./helpers/real-db.mjs";

const mocks = {
	"@/lib/email/auto-reply": "export async function sendMailboxAutoReply(env, input){(globalThis.groupAutoReplies ??= []).push(input)}",
};
const { app, newDatabase } = await loadApp("groups-expand", `
	export * as utils from "./src/lib/groups/expand-utils.ts";
	export { expandGroupDelivery } from "./src/lib/groups/expand.ts";
	export { processInboundMessage } from "./src/lib/email/inbound.ts";
	export { intakeIncomingMail } from "./src/lib/email/intake.ts";
`, { mocks });

test("planChunk splits ordered members after a cursor and reports the next cursor", () => {
	const rows = Array.from({ length: 5 }, (_, i) => ({ id: `m${i}` }));
	assert.deepEqual(app.utils.planChunk(rows, 2), { chunk: rows.slice(0, 2), nextCursor: "m1" });
	assert.deepEqual(app.utils.planChunk(rows.slice(0, 3), 2), { chunk: rows.slice(0, 2), nextCursor: "m1" });
	assert.deepEqual(app.utils.planChunk(rows.slice(0, 2), 2), { chunk: rows.slice(0, 2), nextCursor: null });
	assert.deepEqual(app.utils.planChunk([], 2), { chunk: [], nextCursor: null });
	assert.equal(app.utils.GROUP_EXPANSION_CHUNK, 20);
});

test("the expansion budget lets the first chunk through and defers the rest of a batch", () => {
	const budget = app.utils.createExpansionBudget();
	assert.equal(app.utils.reserveExpansion(budget), true);
	assert.equal(app.utils.reserveExpansion(budget), false);
	assert.ok(app.utils.EXPANSION_CHUNK_COST * 2 > app.utils.EXPANSION_SUBREQUEST_BUDGET);
	assert.equal(app.utils.reserveExpansion(app.utils.createExpansionBudget()), true);
});

test("planDeliveries de-duplicates by mailbox and skips the sender's own mailbox", () => {
	const targets = [{ mailboxId: "a" }, { mailboxId: "b" }, { mailboxId: "a" }, { mailboxId: "c" }];
	assert.deepEqual(app.utils.planDeliveries(targets, null), ["a", "b", "c"]);
	assert.deepEqual(app.utils.planDeliveries(targets, "b"), ["a", "c"]);
});

test("planQueueBatches respects the message count and byte limits", () => {
	const messages = Array.from({ length: 250 }, (_, i) => ({ body: { i } }));
	const batches = app.utils.planQueueBatches(messages, { maxCount: 100, maxBytes: 1e6 });
	assert.deepEqual(batches.map((batch) => batch.length), [100, 100, 50]);
	const big = Array.from({ length: 5 }, () => ({ body: { text: "x".repeat(60_000) } }));
	assert.deepEqual(app.utils.planQueueBatches(big, { maxCount: 100, maxBytes: 200_000 }).map((batch) => batch.length), [3, 2]);
	assert.deepEqual(app.utils.planQueueBatches([], { maxCount: 100, maxBytes: 1 }), []);
});

test("isAccountPrimaryAddress compares the mailbox address with the account email", () => {
	assert.equal(app.utils.isAccountPrimaryAddress("Alice", "Example.com", "alice@example.com"), true);
	assert.equal(app.utils.isAccountPrimaryAddress("alice", "other.com", "alice@example.com"), false);
});

test("the copy key is deterministic per mailbox and message content, whichever group sent it", async () => {
	const bytes = new TextEncoder().encode("same message").buffer;
	const digest = await app.utils.contentDigest(bytes);
	assert.equal(digest, await app.utils.contentDigest(new TextEncoder().encode("same message").buffer));
	assert.notEqual(digest, await app.utils.contentDigest(new TextEncoder().encode("other").buffer));
	const a = await app.utils.groupCopyKey(digest, "m1");
	assert.equal(a, await app.utils.groupCopyKey(digest, "m1"));
	assert.notEqual(a, await app.utils.groupCopyKey(digest, "m2"));
	assert.match(a, /^inbound\/[0-9a-f]{64}\.eml$/);
});

const MEMBERS = 120;
const pad = (n) => String(n).padStart(3, "0");
function seed(count = MEMBERS) {
	let sql = `
		INSERT INTO users (id, email, password_hash, name, role, disabled, created_at) VALUES ('admin', 'admin@example.com', 'hash', 'Admin', 'admin', 0, 1);
		INSERT INTO domains (id, user_id, hostname, zone_id, status, created_at) VALUES ('d1', 'admin', 'example.com', 'z1', 'active', 1);
		INSERT INTO mailboxes (id, user_id, domain_id, local_part, type, created_at) VALUES ('m-support', 'admin', 'd1', 'support', 'shared', 1);
		INSERT INTO mail_groups (id, domain_id, local_part, name, who_can_post, reply_to, disabled, created_at, updated_at) VALUES ('g1', 'd1', 'team', 'Team', 'anyone', 'sender', 0, 1, 1);
		INSERT INTO license_settings (id, instance_id, plan, state, updated_at) VALUES ('default', 'inst', 'team', 'active', 1);
	`;
	for (let i = 0; i < count; i += 1) {
		const n = pad(i);
		sql += `INSERT INTO users (id, email, password_hash, name, role, disabled, created_at) VALUES ('u${n}', 'u${n}@example.com', 'hash', 'U${n}', 'user', 0, 1);
			INSERT INTO mailboxes (id, user_id, domain_id, local_part, type, created_at) VALUES ('mb${n}', 'u${n}', 'd1', 'u${n}', 'personal', 1);
			INSERT INTO mail_group_members (id, group_id, kind, user_id, can_send_as, created_at) VALUES ('gm${n}', 'g1', 'user', 'u${n}', 0, 1);`;
	}
	return sql;
}

const MIME = (from = "Bob <bob@gmail.com>") => `From: ${from}\r\nTo: team@example.com\r\nSubject: Hello team\r\nMessage-ID: <abc@x.test>\r\nDate: Thu, 26 Nov 2026 10:00:00 +0000\r\nContent-Type: text/plain\r\n\r\nhi\r\n`;

async function fixture(t, count = MEMBERS) {
	const database = await newDatabase(t, seed(count));
	const objects = new Map();
	const queue = [];
	const env = {
		...database.env,
		MAILFLARE_RUNTIME: "node",
		BUCKET: {
			get: async (key) => (objects.has(key) ? { arrayBuffer: async () => objects.get(key) } : null),
			put: async (key, body) => { objects.set(key, body); },
			delete: async (key) => { objects.delete(key); },
		},
		INBOUND_QUEUE: {
			send: async (body, options) => { queue.push(body); env.sendOptions.push(options); },
			sendBatch: async (batch) => { env.batches.push(batch.length); for (const message of batch) queue.push(message.body); },
		},
		batches: [],
		sendOptions: [],
		REALTIME: { getByName: () => ({ fetch: async () => new Response(null, { status: 204 }) }) },
	};
	globalThis.__mailflareNodeEnv = env;
	t.after(() => { delete globalThis.__mailflareNodeEnv; globalThis.groupAutoReplies = []; });
	globalThis.groupAutoReplies = [];
	const quiet = console.info; console.info = () => {};
	const warn = console.warn; console.warn = () => {};
	t.after(() => { console.info = quiet; console.warn = warn; });
	const payload = (over = {}) => {
		objects.set("inbound/orig.eml", new TextEncoder().encode(MIME()).buffer);
		return { from: "bob@gmail.com", to: "team@example.com", rawR2Key: "inbound/orig.eml", headers: { from: "Bob <bob@gmail.com>" }, groupExpansion: { groupId: "g1" }, ...over };
	};
	return { ...database, env, objects, queue, payload };
}

const drain = async (env, queue, handler) => {
	let invocations = 0;
	while (queue.length) {
		const message = queue.shift();
		if (message.groupExpansion || message.groupDelivery) { invocations += 1; await handler(message); }
	}
	return invocations;
};

test("120 members are expanded over 6 invocations, one copy each, original deleted after the last", async (t) => {
	const { env, objects, queue, payload, sqlite } = await fixture(t);
	let expansions = 0;
	const deliveries = [];
	queue.push(payload());
	while (queue.length) {
		const message = queue.shift();
		if (message.groupDelivery) { deliveries.push(message); continue; }
		expansions += 1;
		assert.equal(objects.has("inbound/orig.eml"), true, "original is kept until the last chunk");
		await app.expandGroupDelivery(env, message);
	}
	assert.equal(expansions, 6);
	assert.equal(deliveries.length, 120);
	assert.equal(new Set(deliveries.map((d) => d.groupDelivery.mailboxId)).size, 120);
	assert.equal(new Set(deliveries.map((d) => d.rawR2Key)).size, 120);
	assert.ok(deliveries.every((d) => d.to === "team@example.com" && !d.groupExpansion && objects.has(d.rawR2Key)));
	assert.equal(objects.has("inbound/orig.eml"), false);
	assert.deepEqual(env.batches, [20, 20, 20, 20, 20, 20]);
	void sqlite;
});

test("a redelivered chunk re-copies to the same keys and every member still gets one message", async (t) => {
	const { env, objects, queue, payload, sqlite } = await fixture(t);
	queue.push(payload());
	const first = queue.shift();
	await app.expandGroupDelivery(env, first);
	const secondChunk = queue.find((m) => m.groupExpansion);
	const keysBefore = new Set(queue.filter((m) => m.groupDelivery).map((m) => m.rawR2Key));
	queue.length = 0;
	await app.expandGroupDelivery(env, secondChunk); // chunk 2 runs
	await app.expandGroupDelivery(env, secondChunk); // ...and is redelivered
	const redelivered = queue.filter((m) => m.groupDelivery);
	assert.equal(redelivered.length, 40);
	assert.equal(new Set(redelivered.map((m) => m.rawR2Key)).size, 20);
	// Consumer side: both copies of a duplicate message store one row.
	const duplicates = redelivered.filter((m) => m.groupDelivery.mailboxId === redelivered[0].groupDelivery.mailboxId);
	assert.equal(duplicates.length, 2);
	for (const message of duplicates) await app.processInboundMessage(env, message);
	assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM messages WHERE mailbox_id = ?").get(redelivered[0].groupDelivery.mailboxId).n, 1);
	void keysBefore; void objects;
});

test("a group copy is stored in the member mailbox and triggers no auto-reply", async (t) => {
	const { env, queue, payload, sqlite } = await fixture(t, 3);
	sqlite.exec("UPDATE mailboxes SET auto_reply_enabled = 1, auto_reply_body = 'away' WHERE id = 'mb000'");
	queue.push(payload());
	await drain(env, queue, async (message) => {
		if (message.groupExpansion) await app.expandGroupDelivery(env, message);
		else await app.processInboundMessage(env, message);
	});
	const rows = sqlite.prepare("SELECT mailbox_id, to_addr, subject, status FROM messages ORDER BY mailbox_id").all();
	assert.deepEqual(rows.map((r) => r.mailbox_id), ["mb000", "mb001", "mb002"]);
	assert.ok(rows.every((r) => r.subject === "Hello team" && r.to_addr === "team@example.com"));
	assert.equal(globalThis.groupAutoReplies.length, 0);
});

test("a direct delivery still triggers the auto-reply (the mock sees it)", async (t) => {
	const { env, objects, sqlite } = await fixture(t, 1);
	objects.set("inbound/direct.eml", new TextEncoder().encode(MIME()).buffer);
	await app.processInboundMessage(env, { from: "bob@gmail.com", to: "u000@example.com", rawR2Key: "inbound/direct.eml", headers: { from: "bob@gmail.com" } });
	assert.equal(globalThis.groupAutoReplies.length, 1);
	assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM messages").get().n, 1);
});

test("the poster gets no copy when DMARC passed, but does when it did not", async (t) => {
	const { env, queue, payload } = await fixture(t, 3);
	const pass = { "authentication-results": "mx.cloudflare.net; dmarc=pass header.from=example.com", from: "u001@example.com" };
	queue.push(payload({ from: "u001@example.com", headers: pass }));
	await app.expandGroupDelivery(env, queue.shift());
	assert.deepEqual(queue.map((m) => m.groupDelivery.mailboxId), ["mb000", "mb002"]);
	queue.length = 0;
	queue.push(payload({ from: "u001@example.com", headers: { from: "u001@example.com" } }));
	await app.expandGroupDelivery(env, queue.shift());
	assert.deepEqual(queue.map((m) => m.groupDelivery.mailboxId), ["mb000", "mb001", "mb002"]);
});

test("mailbox members, disabled accounts and duplicate targets are handled", async (t) => {
	const { env, queue, payload, sqlite } = await fixture(t, 3);
	sqlite.exec(`
		INSERT INTO mail_group_members (id, group_id, kind, mailbox_id, can_send_as, created_at) VALUES ('gmx1', 'g1', 'mailbox', 'm-support', 0, 1), ('gmx2', 'g1', 'mailbox', 'mb000', 0, 1);
		INSERT INTO mail_group_members (id, group_id, kind, email, can_send_as, created_at) VALUES ('gmx3', 'g1', 'external', 'acct@ext.com', 0, 1);
		UPDATE users SET disabled = 1 WHERE id = 'u001';
		UPDATE mailboxes SET disabled = 1 WHERE id = 'mb002';
	`);
	queue.push(payload());
	await app.expandGroupDelivery(env, queue.shift());
	assert.deepEqual(queue.map((m) => m.groupDelivery.mailboxId).sort(), ["m-support", "mb000"]);
});

test("a copy for a mailbox that left the group is dropped", async (t) => {
	const { env, queue, payload, sqlite, objects } = await fixture(t, 2);
	queue.push(payload());
	await app.expandGroupDelivery(env, queue.shift());
	sqlite.exec("DELETE FROM mail_group_members WHERE id = 'gm001'");
	const copies = queue.splice(0);
	for (const message of copies) await app.processInboundMessage(env, message);
	assert.deepEqual(sqlite.prepare("SELECT mailbox_id FROM messages").all().map((r) => r.mailbox_id), ["mb000"]);
	// The copy's raw object may be shared with another group's copy for the same mailbox, so it is left to the sweeper.
	const left = copies.find((m) => m.groupDelivery.mailboxId === "mb001");
	assert.equal(objects.has(left.rawR2Key), true);
});

test("expansion stops for a disabled group, a lapsed licence and a missing group", async (t) => {
	const { env, queue, payload, sqlite, objects } = await fixture(t, 2);
	sqlite.exec("UPDATE mail_groups SET disabled = 1");
	await app.expandGroupDelivery(env, payload());
	assert.equal(queue.length, 0);
	assert.equal(objects.has("inbound/orig.eml"), false);
	sqlite.exec("UPDATE mail_groups SET disabled = 0; UPDATE license_settings SET plan = 'community'");
	await app.expandGroupDelivery(env, payload());
	assert.equal(queue.length, 0);
	await app.expandGroupDelivery(env, payload({ groupExpansion: { groupId: "nope" } }));
	assert.equal(queue.length, 0);
});

test("two groups addressed in one message each get their own raw object and both deliver", async (t) => {
	const { env, objects, queue, sqlite } = await fixture(t, 2);
	sqlite.exec(`
		INSERT INTO mail_groups (id, domain_id, local_part, name, who_can_post, reply_to, disabled, created_at, updated_at) VALUES ('g2', 'd1', 'sales', 'Sales', 'anyone', 'sender', 0, 1, 1);
		INSERT INTO mail_group_members (id, group_id, kind, mailbox_id, can_send_as, created_at) VALUES ('gs1', 'g2', 'mailbox', 'm-support', 0, 1);
	`);
	const raw = new TextEncoder().encode(MIME()).buffer;
	const input = (to) => ({ from: "bob@gmail.com", to, raw, headers: { from: "Bob <bob@gmail.com>" } });
	const first = await app.intakeIncomingMail(env, input("team@example.com"), {});
	const second = await app.intakeIncomingMail(env, input("sales@example.com"), {});
	assert.notEqual(first.rawR2Key, second.rawR2Key);
	assert.deepEqual(queue.map((m) => m.groupExpansion.groupId), ["g1", "g2"]);
	await drain(env, queue, async (message) => {
		if (message.groupExpansion) await app.expandGroupDelivery(env, message);
		else await app.processInboundMessage(env, message);
	});
	const rows = sqlite.prepare("SELECT mailbox_id FROM messages ORDER BY mailbox_id").all().map((r) => r.mailbox_id);
	assert.deepEqual(rows, ["m-support", "mb000", "mb001"]);
	void objects;
});

test("group mail stored after a live routing failure is admitted and expanded by the consumer", async (t) => {
	const { env, queue, payload, sqlite } = await fixture(t, 2);
	const stored = payload({ groupExpansion: undefined });
	await app.processInboundMessage(env, stored);
	assert.deepEqual(queue.filter((m) => m.groupDelivery).map((m) => m.groupDelivery.mailboxId), ["mb000", "mb001"]);
	// A restricted group still refuses what the live handler would have refused.
	queue.length = 0;
	sqlite.exec("UPDATE mail_groups SET who_can_post = 'org'");
	await app.processInboundMessage(env, payload({ groupExpansion: undefined }));
	assert.equal(queue.length, 0);
	// And a loop is still dropped.
	sqlite.exec("UPDATE mail_groups SET who_can_post = 'anyone'");
	await app.processInboundMessage(env, payload({ groupExpansion: undefined, headers: { from: "Bob <bob@gmail.com>", "x-mailflare-group": "g1" } }));
	assert.equal(queue.length, 0);
});

test("a multi-address From never counts as the poster for the self-skip", async (t) => {
	const { env, queue, payload } = await fixture(t, 3);
	const headers = { "authentication-results": "mx.cloudflare.net; dmarc=pass header.from=example.com", from: "u001@example.com, x@y.com" };
	await app.expandGroupDelivery(env, payload({ headers }));
	assert.deepEqual(queue.map((m) => m.groupDelivery.mailboxId), ["mb000", "mb001", "mb002"]);
});

test("a batch of expansion chunks is deferred past the subrequest budget, not lost", async (t) => {
	const { env, queue, payload } = await fixture(t, 60);
	const budget = app.utils.createExpansionBudget();
	await app.expandGroupDelivery(env, payload(), { budget });
	const continuation = queue.find((m) => m.groupExpansion?.cursor);
	assert.equal(queue.filter((m) => m.groupDelivery).length, 20);
	queue.length = 0;
	env.sendOptions.length = 0;
	await app.expandGroupDelivery(env, continuation, { budget });
	assert.deepEqual(queue, [continuation]);
	assert.ok(env.sendOptions[0].delaySeconds > 0);
	await app.expandGroupDelivery(env, queue.shift(), { budget: app.utils.createExpansionBudget() });
	assert.equal(queue.filter((m) => m.groupDelivery).length, 20);
});

test("a mailbox in two groups addressed in one message gets one copy", async (t) => {
	const { env, queue, sqlite } = await fixture(t, 1);
	sqlite.exec(`
		INSERT INTO mail_groups (id, domain_id, local_part, name, who_can_post, reply_to, disabled, created_at, updated_at) VALUES ('g2', 'd1', 'sales', 'Sales', 'anyone', 'sender', 0, 1, 1);
		INSERT INTO mail_group_members (id, group_id, kind, mailbox_id, can_send_as, created_at) VALUES ('gs1', 'g2', 'mailbox', 'mb000', 0, 1);
	`);
	const raw = new TextEncoder().encode(MIME()).buffer;
	const input = (to) => ({ from: "bob@gmail.com", to, raw, headers: { from: "Bob <bob@gmail.com>" } });
	await app.intakeIncomingMail(env, input("team@example.com"), {});
	await app.intakeIncomingMail(env, input("sales@example.com"), {});
	await drain(env, queue, async (message) => {
		if (message.groupExpansion) await app.expandGroupDelivery(env, message);
		else await app.processInboundMessage(env, message);
	});
	assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM messages WHERE mailbox_id = 'mb000'").get().n, 1);
});

test("re-admitted group mail is copied to the group's own key and leaves the shared object alone", async (t) => {
	const { env, queue, payload, objects } = await fixture(t, 2);
	await app.processInboundMessage(env, payload({ groupExpansion: undefined }));
	assert.equal(objects.has("inbound/orig.eml"), true);
	const keys = new Set(queue.filter((m) => m.groupDelivery).map((m) => m.rawR2Key));
	assert.equal(keys.size, 2);
	const scoped = objects.size;
	// A retry of the same message is idempotent: same scoped key, no extra objects.
	queue.length = 0;
	await app.processInboundMessage(env, payload({ groupExpansion: undefined }));
	assert.equal(objects.size, scoped);
});

test("re-admitted group mail with too many Received headers is dropped", async (t) => {
	const { env, queue, payload, objects } = await fixture(t, 2);
	const hops = Array.from({ length: 31 }, (_, i) => `Received: from h${i}.example by mx.example; Thu, 26 Nov 2026 10:00:00 +0000\r\n`).join("");
	const p = payload({ groupExpansion: undefined });
	objects.set("inbound/orig.eml", new TextEncoder().encode(hops + MIME()).buffer);
	await app.processInboundMessage(env, p);
	assert.equal(queue.length, 0);
});

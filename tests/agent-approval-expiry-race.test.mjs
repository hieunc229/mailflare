import assert from "node:assert/strict";
import test from "node:test";
import { loadApp } from "./helpers/real-db.mjs";

// The claim and the expiry write in `confirmAgentSend` are separate statements, so a confirmation can
// read a pending request, another confirmation can read the same request after its deadline, and the
// two writes can land in either order. These tests hold each write at the database boundary to force the
// interleaving deterministically, instead of hoping a sleep-based race fires.

/** A pause a test releases; `arrived` resolves when the gated query is about to run. */
function gate() {
	let release;
	const opened = new Promise((resolve) => { release = resolve; });
	let arrive;
	const arrived = new Promise((resolve) => { arrive = resolve; });
	return { opened, arrived, open: () => release(), arrive: () => arrive() };
}

globalThis.__approvalGates = { claim: null, expire: null };

/** Which gate holds a status write, chosen by the values being written. */
globalThis.__approvalGateFor = (values) => {
	if (!values || typeof values !== "object") return null;
	if (values.status === "claimed") return globalThis.__approvalGates.claim;
	if (values.status === "expired") return globalThis.__approvalGates.expire;
	return null;
};

/** Delay a query builder's execution until `state.opened` resolves. */
globalThis.__approvalDefer = (query, state) => new Proxy(query, {
	get(target, property) {
		if (property === "then") {
			return (resolve, reject) => {
				state.arrive();
				state.opened.then(() => target.then(resolve, reject));
			};
		}
		const value = Reflect.get(target, property, target);
		if (typeof value !== "function") return value;
		return (...args) => {
			const next = value.apply(target, args);
			return next && typeof next === "object" ? globalThis.__approvalDefer(next, state) : next;
		};
	},
});

/** The real database, with the two approval status writes pausable. */
globalThis.__approvalGateDb = (db) => new Proxy(db, {
	get(target, property) {
		const value = Reflect.get(target, property, target);
		if (property !== "update") return typeof value === "function" ? value.bind(target) : value;
		return (table) => new Proxy(target.update(table), {
			get(query, key) {
				const inner = Reflect.get(query, key, query);
				if (key !== "set") return typeof inner === "function" ? inner.bind(query) : inner;
				return (values) => {
					const state = globalThis.__approvalGateFor(values);
					const next = query.set(values);
					return state ? globalThis.__approvalDefer(next, state) : next;
				};
			},
		});
	},
});

const { app, newDatabase } = await loadApp("agent-approval-expiry-race", `
	export { confirmAgentSend, requestAgentSend } from "./src/lib/agent/approvals/utils.ts";
	export { agentSendApprovals, appSettings, domains, mailboxes, messages, users } from "./src/db/schema/index.ts";
	export { agentDraftMetadata } from "./src/db/schema/index.ts";
`, { mocks: {
	"@/db": `
		import { createDb } from "./src/db/index.ts";
		export * from "./src/db/index.ts";
		export const getDb = (env) => globalThis.__approvalGateDb(createDb(env.DB));
	`,
} });

const owner = { id: "owner", email: "owner@example.com", role: "user" };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(condition, what, timeout = 4000) {
	const started = Date.now();
	while (!condition()) {
		if (Date.now() - started > timeout) throw new Error(`timed out waiting for ${what}`);
		await sleep(5);
	}
}

/** A mailbox with one agent draft scheduled an hour out, so the send pipeline enqueues instead of calling a provider. */
const seed = `
	INSERT INTO users (id, email, password_hash, name, role, created_at) VALUES ('owner', 'owner@example.com', 'hash', 'Owner', 'user', 1);
	INSERT INTO domains (id, user_id, hostname, zone_id, status, created_at) VALUES ('domain-1', 'owner', 'example.com', 'zone-1', 'active', 1);
	INSERT INTO mailboxes (id, user_id, domain_id, local_part, created_at) VALUES ('mb-owner', 'owner', 'domain-1', 'owner', 1);
	INSERT INTO messages (id, user_id, mailbox_id, direction, from_addr, to_addr, subject, text_body, status, created_at)
		VALUES ('draft-1', 'owner', 'mb-owner', 'outbound', 'owner@example.com', 'friend@example.net', 'Hello', 'Body', 'draft', 1);
	INSERT INTO agent_draft_metadata (draft_id, mailbox_id, origin, revision, scheduled_at, created_at)
		VALUES ('draft-1', 'mb-owner', 'mcp', 1, 4102444800, 1);
`;

const approvalStatus = (sqlite, id) => sqlite.prepare("SELECT status, message_id FROM agent_send_approvals WHERE id = ?").get(id);
const queuedMessages = (sqlite) => sqlite.prepare("SELECT id, subject FROM messages WHERE status = 'queued'").all();

async function setUp(t) {
	const { env, sqlite } = await newDatabase(t, seed);
	const deliveries = [];
	const queueGate = gate();
	globalThis.__approvalGates.claim = null;
	globalThis.__approvalGates.expire = null;
	env.OUTBOUND_QUEUE = {
		send: (message) => {
			deliveries.push(message);
			return queueGate.opened;
		},
	};
	const request = await app.requestAgentSend(env, owner, "draft-1", 1);
	return { env, sqlite, deliveries, queueGate, approvalId: request.approvalId };
}

test("a claim that lands past its deadline cannot take the request: expiry wins, nothing sends", async (t) => {
	const { env, sqlite, deliveries, queueGate, approvalId } = await setUp(t);

	// 1. A confirmation reads the still-pending request before its deadline, then stops before its claim.
	globalThis.__approvalGates.claim = gate();
	const preDeadline = app.confirmAgentSend(env, owner, approvalId);
	await globalThis.__approvalGates.claim.arrived;

	// 2. The deadline passes while that confirmation is between its read and its claim.
	sqlite.prepare("UPDATE agent_send_approvals SET expires_at = ? WHERE id = ?").run(Math.floor(Date.now() / 1000) - 60, approvalId);

	// 3. A second confirmation reads the same request (still `pending`, now expired) and stops before it
	//    writes `expired`.
	globalThis.__approvalGates.expire = gate();
	const postDeadline = app.confirmAgentSend(env, owner, approvalId).then(
		(value) => ({ value }),
		(error) => ({ error }),
	);
	await globalThis.__approvalGates.expire.arrived;

	// 4. The pre-deadline claim now runs, but the claim itself carries the deadline: it cannot take an
	//    expired request, so the early confirmation just reports the state it found.
	globalThis.__approvalGates.claim.open();
	const early = await preDeadline;
	assert.equal(early.status, "pending");
	assert.equal(approvalStatus(sqlite, approvalId).status, "pending");

	// 5. The expiry write then lands and wins: the late confirmation throws the reason, the request is
	//    expired, and nothing was ever queued or delivered.
	globalThis.__approvalGates.expire.open();
	const late = await postDeadline;
	assert.match(late.error?.message ?? `${late.error}`, /Approval expired/);
	assert.equal(approvalStatus(sqlite, approvalId).status, "expired");
	assert.equal(deliveries.length, 0);
	assert.equal(queuedMessages(sqlite).length, 0);

	// 6. `expired` never entered the delivery index, so the draft is released for a fresh request.
	const next = await app.requestAgentSend(env, owner, "draft-1", 1);
	assert.equal(next.status, "pending_approval");
	assert.equal(sqlite.prepare("SELECT count(*) AS n FROM agent_send_approvals").get().n, 2);
	queueGate.open();
	assert.equal(deliveries.length, 0);
});

test("an unclaimed request past its deadline is still expired, never sent", async (t) => {
	const { env, sqlite, deliveries, queueGate, approvalId } = await setUp(t);
	sqlite.prepare("UPDATE agent_send_approvals SET expires_at = ? WHERE id = ?").run(Math.floor(Date.now() / 1000) - 60, approvalId);

	await assert.rejects(app.confirmAgentSend(env, owner, approvalId), /Approval expired/);
	assert.equal(approvalStatus(sqlite, approvalId).status, "expired");
	assert.equal(deliveries.length, 0);
	assert.equal(queuedMessages(sqlite).length, 0);
	// A later confirmation reports the expired state without sending.
	const later = await app.confirmAgentSend(env, owner, approvalId);
	assert.equal(later.status, "expired");
	assert.equal(deliveries.length, 0);
	queueGate.open();
	assert.equal(queuedMessages(sqlite).length, 0);
});

test("a decided request keeps its state when a stale confirmation arrives", async (t) => {
	const { env, sqlite, deliveries, queueGate, approvalId } = await setUp(t);
	globalThis.__approvalGates.claim = gate();
	const first = app.confirmAgentSend(env, owner, approvalId);
	await globalThis.__approvalGates.claim.arrived;
	globalThis.__approvalGates.claim.open();
	await waitFor(() => approvalStatus(sqlite, approvalId)?.status === "claimed", "the claim");
	// While the first send is in flight, a second confirmation reads `claimed` and returns it.
	const second = await app.confirmAgentSend(env, owner, approvalId);
	assert.equal(second.status, "claimed");
	queueGate.open();
	assert.equal((await first).status, "sent");
	assert.equal(deliveries.length, 1);
	assert.equal(queuedMessages(sqlite).length, 1);
	assert.equal(approvalStatus(sqlite, approvalId).status, "sent");
});

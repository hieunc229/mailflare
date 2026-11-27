import assert from "node:assert/strict";
import test from "node:test";
import { loadApp } from "./helpers/real-db.mjs";

// The real `approve_send` handler and the real approval service against a real database; only the MCP
// transport is replaced, so what the caller sees (isError and the payload) is what the tool returns.

const { app, newDatabase } = await loadApp("mcp-approve-send", `export { createMailflareMcpHandler } from "./src/lib/mcp/server.ts"; export { requestAgentSend } from "./src/lib/agent/approvals/utils.ts";`, { mocks: {
	"@modelcontextprotocol/server": `
		export class McpServer { constructor() { this.tools = new Map(); } registerTool(name, config, handler) { this.tools.set(name, handler); } }
		export const createMcpHandler = (factory) => factory();
	`,
	"@/lib/agent/tools": `export const EMAIL_TOOL_NAMES = []; export const emailToolDescriptions = { edit_draft: "" }; export const emailToolSchemas = { edit_draft: { shape: {} } }; export const runEmailTool = () => { throw new Error("not under test"); };`,
	"@/lib/agent/edit-draft": `export const editAgentDraft = () => { throw new Error("not under test"); };`,
	"@/lib/calendar/tools": `export const CALENDAR_TOOL_NAMES = []; export const calendarToolDescriptions = {}; export const calendarToolSchemas = {}; export const calendarToolScope = () => "mcp:calendar-read"; export const runCalendarTool = () => { throw new Error("not under test"); };`,
	"./admin-tools": `export const registerAdminMcpTools = () => {};`,
} });

const owner = { id: "owner", email: "owner@example.com", role: "user" };
const seed = `
	INSERT INTO users (id, email, password_hash, name, role, created_at) VALUES ('owner', 'owner@example.com', 'hash', 'Owner', 'user', 1);
	INSERT INTO domains (id, user_id, hostname, zone_id, status, created_at) VALUES ('domain-1', 'owner', 'example.com', 'zone-1', 'active', 1);
	INSERT INTO mailboxes (id, user_id, domain_id, local_part, created_at) VALUES ('mb-owner', 'owner', 'domain-1', 'owner', 1);
	INSERT INTO api_keys (id, kind, user_id, name, prefix, key_hash, scopes, can_approve_own_sends, created_at) VALUES
		('key-owner', 'mcp', 'owner', 'Agent', 'ep_owner', 'h', '["mcp:request-send"]', 1, 1),
		('key-other', 'mcp', 'owner', 'Other', 'ep_other', 'h', '["mcp:request-send"]', 1, 1),
		('key-plain', 'mcp', 'owner', 'Plain', 'ep_plain', 'h', '["mcp:request-send"]', 0, 1);
	INSERT INTO messages (id, user_id, mailbox_id, direction, from_addr, to_addr, subject, text_body, status, created_at)
		VALUES ('draft-1', 'owner', 'mb-owner', 'outbound', 'owner@example.com', 'friend@example.net', 'Hello', 'Body', 'draft', 1);
	INSERT INTO agent_draft_metadata (draft_id, mailbox_id, origin, revision, scheduled_at, created_at)
		VALUES ('draft-1', 'mb-owner', 'mcp', 1, 4102444800, 1);
`;

const principal = (keyId = "key-owner", canApproveOwnSends = true) => ({ keyId, user: owner, scopes: ["mcp:request-send"], mailboxIds: ["mb-owner"], canApproveOwnSends });

async function setUp(t, seedSql = seed) {
	const { env, sqlite } = await newDatabase(t, seedSql);
	const deliveries = [];
	env.OUTBOUND_QUEUE = { send: (message) => deliveries.push(message) };
	const call = async (principalValue, approvalId) => {
		const server = app.createMailflareMcpHandler(env, principalValue, "https://mailflare.test", "");
		const result = await server.tools.get("approve_send")({ mailboxId: "mb-owner", approvalId });
		return { isError: !!result.isError, data: JSON.parse(result.content[0].text) };
	};
	return { env, sqlite, deliveries, call };
}

/** A decision the database already holds, written straight into the approval table. */
function decided(sqlite, id, status, messageId = null, requestKeyId = "key-owner", expiresAt = 4102444800, draftId = "draft-1") {
	sqlite.prepare("INSERT INTO agent_send_approvals (id, draft_id, mailbox_id, user_id, request_key_id, revision, payload_hash, status, message_id, expires_at, created_at) VALUES (?, ?, 'mb-owner', 'owner', ?, 1, 'hash', ?, ?, ?, 1)")
		.run(id, draftId, requestKeyId, status, messageId, expiresAt);
}

test("an already-claimed request is a successful answer, not an error", async (t) => {
	const { sqlite, call, deliveries } = await setUp(t);
	decided(sqlite, "ap-claimed", "claimed");
	const result = await call(principal(), "ap-claimed");
	assert.equal(result.isError, false, JSON.stringify(result.data));
	assert.deepEqual(result.data, { approvalId: "ap-claimed", status: "claimed", messageId: null });
	assert.equal(deliveries.length, 0);
	assert.equal(sqlite.prepare("SELECT status FROM agent_send_approvals WHERE id = 'ap-claimed'").get().status, "claimed");
});

test("an already-sent request returns the delivery status and message id", async (t) => {
	const { sqlite, call, deliveries } = await setUp(t);
	sqlite.prepare("INSERT INTO messages (id, user_id, mailbox_id, direction, from_addr, to_addr, subject, status, created_at) VALUES ('sent-1', 'owner', 'mb-owner', 'outbound', 'owner@example.com', 'friend@example.net', 'Hello', 'queued', 2)").run();
	decided(sqlite, "ap-sent", "sent", "sent-1");
	const result = await call(principal(), "ap-sent");
	assert.equal(result.isError, false, JSON.stringify(result.data));
	assert.deepEqual(result.data, { approvalId: "ap-sent", status: "queued", messageId: "sent-1" });
	assert.equal(deliveries.length, 0);
});

test("an expired request is refused with the expiry reason, not as a permissions problem", async (t) => {
	const { sqlite, call, deliveries } = await setUp(t);
	decided(sqlite, "ap-expired", "expired");
	const result = await call(principal(), "ap-expired");
	assert.equal(result.isError, true);
	assert.equal(result.data.code, "expired");
	assert.equal(result.data.status, "expired");
	assert.equal(deliveries.length, 0);
});

test("a pending request past its deadline is refused as expired and never sent", async (t) => {
	const { sqlite, call, deliveries } = await setUp(t);
	decided(sqlite, "ap-late", "pending", null, "key-owner", Math.floor(Date.now() / 1000) - 60);
	const result = await call(principal(), "ap-late");
	assert.equal(result.isError, true);
	assert.equal(result.data.code, "expired");
	assert.equal(sqlite.prepare("SELECT status FROM agent_send_approvals WHERE id = 'ap-late'").get().status, "expired");
	assert.equal(deliveries.length, 0);
});

test("the flag and the key check stay refusals, with their own reasons", async (t) => {
	const { sqlite, call, deliveries } = await setUp(t);
	decided(sqlite, "ap-mine", "pending");
	const noFlag = await call(principal("key-plain", false), "ap-mine");
	assert.equal(noFlag.isError, true);
	assert.equal(noFlag.data.code, "permission_denied");
	const otherKey = await call(principal("key-other"), "ap-mine");
	assert.equal(otherKey.isError, true);
	assert.equal(otherKey.data.code, "not_found");
	assert.equal(sqlite.prepare("SELECT status FROM agent_send_approvals WHERE id = 'ap-mine'").get().status, "pending");
	assert.equal(deliveries.length, 0);
});

test("a fresh request is approved through the pipeline and reported as queued", async (t) => {
	const { env, sqlite, call, deliveries } = await setUp(t);
	const request = await app.requestAgentSend(env, owner, "draft-1", 1, "key-owner");
	const result = await call(principal(), request.approvalId);
	assert.equal(result.isError, false, JSON.stringify(result.data));
	assert.equal(result.data.status, "queued");
	assert.equal(typeof result.data.messageId, "string");
	assert.equal(deliveries.length, 1);
	assert.equal(deliveries[0].messageId, result.data.messageId);
	assert.equal(sqlite.prepare("SELECT count(*) AS n FROM messages WHERE status = 'queued'").get().n, 1);
	// Approving the same request again answers with the same status instead of a second send.
	const again = await call(principal(), request.approvalId);
	assert.equal(again.isError, false, JSON.stringify(again.data));
	assert.deepEqual(again.data, { approvalId: request.approvalId, status: "queued", messageId: result.data.messageId });
	assert.equal(deliveries.length, 1);
});

test("MySQL refuses approve_send, and the same approval still works on SQLite", async (t) => {
	const { env, sqlite, call } = await setUp(t);
	decided(sqlite, "ap-mine", "pending");
	let drizzleCalls = 0;
	// `dialectOf` reads the connection's own config, exactly as the migrations service does
	// (`src/lib/migrations/service.ts:34`); this stands in for a MySQL deployment, which needs no server
	// to check the guard's decision. The refusal's audit row is written through env.DB like any other,
	// so the fake hands the test database's drizzle back and counts the call. The MySQL-side
	// double-send itself was proven by the auditor's /tmp reproduction, not here.
	const mysqlEnv = {
		DB: { config: { dialect: "mysql" }, createDrizzle: () => { drizzleCalls += 1; return app.getDb({ DB: env.DB }); } },
		OUTBOUND_QUEUE: { send: () => { throw new Error("no delivery expected"); } },
	};
	const server = app.createMailflareMcpHandler(mysqlEnv, principal(), "https://mailflare.test", "");
	const refusal = await server.tools.get("approve_send")({ mailboxId: "mb-owner", approvalId: "ap-mine" });
	const data = JSON.parse(refusal.content[0].text);
	assert.equal(refusal.isError, true);
	assert.equal(data.code, "unsupported_dialect");
	assert.match(data.error, /MySQL/);
	assert.match(data.error, /web review page/);
	// The refusal's only database work is its audit row; the approval read and transition never run.
	assert.equal(drizzleCalls, 1);
	assert.equal(sqlite.prepare("SELECT status FROM agent_send_approvals WHERE id = 'ap-mine'").get().status, "pending");
	const audited = sqlite.prepare("SELECT metadata FROM audit_logs WHERE action = 'email.approve_send'").all().map((row) => JSON.parse(row.metadata));
	assert.ok(audited.some((metadata) => metadata.approvalId === "ap-mine" && metadata.status === "unsupported_dialect" && metadata.keyId === "key-owner"), "the dialect refusal is audited");

	// The gate is the dialect, not the approval: the same request on SQLite is answered as usual.
	sqlite.prepare("UPDATE agent_send_approvals SET status = 'claimed' WHERE id = 'ap-mine'").run();
	const sqliteResult = await call(principal(), "ap-mine");
	assert.equal(sqliteResult.isError, false, JSON.stringify(sqliteResult.data));
	assert.deepEqual(sqliteResult.data, { approvalId: "ap-mine", status: "claimed", messageId: null });
});

test("every refusal writes an email.approve_send audit row with its reason", async (t) => {
	const { sqlite, call, deliveries } = await setUp(t);
	decided(sqlite, "ap-mine", "pending");
	const flagOff = await call(principal("key-plain", false), "ap-mine");
	assert.equal(flagOff.isError, true);
	assert.equal(flagOff.data.code, "permission_denied");
	const foreign = await call(principal("key-other"), "ap-mine");
	assert.equal(foreign.isError, true);
	assert.equal(foreign.data.code, "not_found");
	const missing = await call(principal(), "ap-nope");
	assert.equal(missing.isError, true);
	assert.equal(missing.data.code, "not_found");
	// A key without the send-review scope hits the first check; it keeps a mail scope so the tool exists.
	const scopedOut = await call({ keyId: "key-owner", user: owner, scopes: ["mcp:read"], mailboxIds: ["mb-owner"], canApproveOwnSends: true }, "ap-mine");
	assert.equal(scopedOut.isError, true);
	assert.equal(scopedOut.data.code, "permission_denied");
	const audited = sqlite.prepare("SELECT actor_user_id AS actor, mailbox_id AS mailbox, metadata FROM audit_logs WHERE action = 'email.approve_send'").all()
		.map((row) => ({ ...row, metadata: JSON.parse(row.metadata) }));
	const refusal = (status, approvalId, keyId = "key-owner") =>
		audited.find((row) => row.metadata.status === status && row.metadata.approvalId === approvalId && row.metadata.keyId === keyId);
	assert.ok(refusal("permission_denied", "ap-mine", "key-plain"), "the flag-off refusal is audited");
	assert.ok(refusal("not_found", "ap-mine", "key-other"), "the other-key refusal is audited");
	assert.ok(refusal("not_found", "ap-nope"), "the unknown-approval refusal is audited");
	assert.ok(refusal("permission_denied", "ap-mine", "key-owner"), "the scope refusal is audited");
	assert.ok(audited.every((row) => row.actor === "owner" && row.mailbox === "mb-owner" && row.metadata.origin === "mcp"));
	// Refusals change nothing.
	assert.equal(deliveries.length, 0);
	assert.equal(sqlite.prepare("SELECT status FROM agent_send_approvals WHERE id = 'ap-mine'").get().status, "pending");
});

test("a decided request reports the message's real status, never a fabricated sent", async (t) => {
	const { sqlite, call } = await setUp(t);
	// The send that failed its delivery, and the one cancelled back to Drafts before it went out.
	sqlite.prepare("INSERT INTO messages (id, user_id, mailbox_id, direction, from_addr, to_addr, subject, status, created_at) VALUES ('fail-1', 'owner', 'mb-owner', 'outbound', 'owner@example.com', 'friend@example.net', 'Hello', 'failed', 2)").run();
	sqlite.prepare("INSERT INTO messages (id, user_id, mailbox_id, direction, from_addr, to_addr, subject, status, created_at) VALUES ('draft-2', 'owner', 'mb-owner', 'outbound', 'owner@example.com', 'friend@example.net', 'Hello', 'draft', 2), ('back-1', 'owner', 'mb-owner', 'outbound', 'owner@example.com', 'friend@example.net', 'Hello', 'draft', 2)").run();
	// A second delivery state on one draft would collide in the partial unique index, so each gets its own.
	decided(sqlite, "ap-failed", "sent", "fail-1");
	decided(sqlite, "ap-draft", "sent", "back-1", "key-owner", 4102444800, "draft-2");
	const failed = await call(principal(), "ap-failed");
	assert.equal(failed.isError, false, JSON.stringify(failed.data));
	assert.deepEqual(failed.data, { approvalId: "ap-failed", status: "failed", messageId: "fail-1" });
	const draftBack = await call(principal(), "ap-draft");
	assert.equal(draftBack.isError, false, JSON.stringify(draftBack.data));
	assert.deepEqual(draftBack.data, { approvalId: "ap-draft", status: "draft", messageId: "back-1" });
	const audited = sqlite.prepare("SELECT metadata FROM audit_logs WHERE action = 'email.approve_send'").all().map((row) => JSON.parse(row.metadata));
	assert.ok(audited.some((metadata) => metadata.approvalId === "ap-failed" && metadata.status === "failed"), "the audit does not record the failed send as delivered either");
});

test("two pending approvals on one draft cannot both be claimed", async (t) => {
	const { env, sqlite, call, deliveries } = await setUp(t);
	// `requestAgentSend` only refuses a draft with a delivery already in flight, so two pending
	// approvals for draft-1 can exist; the partial unique index is what keeps the second from sending.
	const first = await app.requestAgentSend(env, owner, "draft-1", 1, "key-owner");
	const second = await app.requestAgentSend(env, owner, "draft-1", 1, "key-owner");
	// The first approval's claim won elsewhere and its send is still running, so the draft is intact.
	sqlite.prepare("UPDATE agent_send_approvals SET status = 'claimed', claimed_at = ? WHERE id = ?").run(Math.floor(Date.now() / 1000), first.approvalId);
	const result = await call(principal(), second.approvalId);
	assert.equal(result.isError, true);
	assert.match(result.data.error, /delivery already in progress/);
	assert.doesNotMatch(result.data.error ?? "", /UNIQUE|Failed query|constraint/i);
	assert.equal(sqlite.prepare("SELECT status FROM agent_send_approvals WHERE id = ?").get(second.approvalId).status, "pending");
	assert.equal(deliveries.length, 0);
});

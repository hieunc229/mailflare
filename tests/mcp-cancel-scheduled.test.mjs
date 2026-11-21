import assert from "node:assert/strict";
import test from "node:test";
import { loadApp, sharedMailboxSeed } from "./helpers/real-db.mjs";

// The real tool handlers run against a recording MCP server and stubs for everything outside the tool under test.
const { app, newDatabase } = await loadApp("mcp-cancel-scheduled", `export { createMailflareMcpHandler } from "./src/lib/mcp/server.ts";`, { mocks: {
	"@modelcontextprotocol/server": `
		export class McpServer { constructor() { this.tools = new Map(); } registerTool(name, config, handler) { this.tools.set(name, handler); } }
		export const createMcpHandler = (factory) => factory();
	`,
	"@/lib/agent/tools": `export const EMAIL_TOOL_NAMES = []; export const emailToolDescriptions = { edit_draft: "" }; export const emailToolSchemas = { edit_draft: { shape: {} } }; export const runEmailTool = () => { throw new Error("not under test"); };`,
	"@/lib/agent/edit-draft": `export const editAgentDraft = () => { throw new Error("not under test"); };`,
	"@/lib/agent/approvals/utils": `export const requestAgentSend = () => { throw new Error("not under test"); }; export const getAgentSendRequest = () => { throw new Error("not under test"); };`,
	"@/lib/calendar/tools": `export const CALENDAR_TOOL_NAMES = []; export const calendarToolDescriptions = {}; export const calendarToolSchemas = {}; export const calendarToolScope = () => "mcp:calendar-read"; export const runCalendarTool = () => { throw new Error("not under test"); };`,
	"./admin-tools": `export const registerAdminMcpTools = () => {};`,
} });

const scheduled = (permission) => `${sharedMailboxSeed(permission)}
	INSERT INTO messages (id, user_id, mailbox_id, direction, from_addr, to_addr, subject, status, created_at) VALUES
		('m-sched', 'author', 'mb-team', 'outbound', 'team@example.com', 'x@example.net', 'Later', 'queued', 2);
	INSERT INTO outbound_jobs (id, user_id, message_id, status, payload, scheduled_at, created_at, updated_at) VALUES ('job-1', 'author', 'm-sched', 'queued', '{}', 4102444800, 1, 1);
`;

async function cancelAs(t, permission, who = "delegate") {
	const { env, sqlite } = await newDatabase(t, scheduled(permission));
	const delegate = { id: who, email: `${who}@example.com`, role: "user" };
	const server = app.createMailflareMcpHandler(env, { keyId: "key", user: delegate, scopes: ["mcp:read", "mcp:draft"], mailboxIds: ["mb-team"] }, "http://localhost", "");
	const result = await server.tools.get("cancel_scheduled_send")({ mailboxId: "mb-team", messageId: "m-sched" });
	return { data: JSON.parse(result.content[0].text), isError: !!result.isError, sqlite };
}

test("a read_only delegate cannot cancel a colleague's scheduled send over MCP", async (t) => {
	const { data, isError, sqlite } = await cancelAs(t, "read_only");
	assert.equal(isError, true);
	assert.equal(data.error, "Permission denied");
	assert.equal(sqlite.prepare("SELECT status FROM messages WHERE id = 'm-sched'").get().status, "queued");
	assert.equal(sqlite.prepare("SELECT count(*) AS n FROM outbound_jobs").get().n, 1);
});

test("a delegate who may send on behalf can still cancel", async (t) => {
	const { data, isError, sqlite } = await cancelAs(t, "send_on_behalf");
	assert.equal(isError, false, JSON.stringify(data));
	assert.equal(sqlite.prepare("SELECT status FROM messages WHERE id = 'm-sched'").get().status, "draft");
	// The draft now belongs to its author alone, so the colleague who cancelled gets no id to open.
	assert.equal(data.status, "cancelled");
	assert.equal("draftId" in data, false, JSON.stringify(data));
});

test("the author who cancels their own scheduled send gets the draft id", async (t) => {
	const { data, isError } = await cancelAs(t, "send_on_behalf", "author");
	assert.equal(isError, false, JSON.stringify(data));
	assert.deepEqual(data, { messageId: "m-sched", status: "cancelled", draftId: "m-sched" });
});

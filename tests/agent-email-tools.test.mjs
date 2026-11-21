import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const bundleDirectory = mkdtempSync(join(root, "node_modules", "mailflare-agent-bundle-"));
await build({
	stdin: {
		contents: `
			export { SqliteDatabase } from "./server/runtime/sqlite-database.ts";
			export { applyMigrations } from "./server/runtime/migrate.ts";
			export { createAgentChatStream } from "./src/lib/agent/chat.ts";
			export { runEmailTool } from "./src/lib/agent/tools.ts";
			export { requestAgentSend } from "./src/lib/agent/approvals/utils.ts";
			export { createSession } from "./src/lib/auth/session.ts";
			export { POST as postAgentChat } from "./src/app/api/agent/chat/route.ts";
		`,
		resolveDir: root,
		sourcefile: "agent-test-entry.ts",
	},
	outfile: join(bundleDirectory, "entry.mjs"),
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node24",
	tsconfig: join(root, "tsconfig.json"),
	packages: "external",
	alias: {
		"next/headers": "next/headers.js",
		"cloudflare:workers": "./server/runtime/cloudflare-workers.ts",
	},
	logLevel: "silent",
});
const { SqliteDatabase, applyMigrations, createAgentChatStream, runEmailTool, requestAgentSend, createSession, postAgentChat } = await import(pathToFileURL(join(bundleDirectory, "entry.mjs")).href);
after(() => rmSync(bundleDirectory, { recursive: true, force: true }));

test("assistant reads mail, creates an editable reply draft, and invokes tools through chat", async (t) => {
	const directory = mkdtempSync(join(tmpdir(), "mailflare-agent-"));
	const database = new SqliteDatabase(join(directory, "mailflare.sqlite"));
	t.after(() => {
		database.db.close();
		rmSync(directory, { recursive: true, force: true });
	});
	await applyMigrations(database, join(process.cwd(), "drizzle", "migrations"));
	database.db.exec(`
		INSERT INTO users (id, email, password_hash, name, created_at) VALUES ('user-1', 'owner@example.com', 'hash', 'Owner', 1);
		INSERT INTO domains (id, user_id, hostname, zone_id, status, created_at) VALUES ('domain-1', 'user-1', 'example.com', 'zone-1', 'active', 1);
		INSERT INTO mailboxes (id, user_id, domain_id, local_part, created_at) VALUES ('mailbox-1', 'user-1', 'domain-1', 'owner', 1);
		INSERT INTO messages (id, user_id, mailbox_id, direction, provider_message_id, from_addr, to_addr, subject, text_body, status, thread_id, created_at)
		VALUES ('email-1', 'user-1', 'mailbox-1', 'inbound', '<email-1@example.net>', 'customer@example.net', 'owner@example.com', 'Question', 'Can we meet Tuesday?', 'received', 'thread-1', 2);
	`);

	const server = createServer(async (request, response) => {
		let raw = "";
		for await (const chunk of request) raw += chunk;
		const body = JSON.parse(raw);
		const hasToolResult = body.messages.some((message) => message.role === "tool");
		response.writeHead(200, { "Content-Type": "text/event-stream" });
		const chunk = (delta, finishReason = null) => response.write(`data: ${JSON.stringify({ id: "mock-1", object: "chat.completion.chunk", created: 1, model: "test-model", choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`);
		const drafting = JSON.stringify(body.messages).includes("Draft a reply");
		if (hasToolResult) {
			chunk({ role: "assistant", content: drafting ? "I created a reply draft for review." : "I found one email in your inbox." });
			chunk({}, "stop");
		} else {
			chunk({ role: "assistant", tool_calls: [{ index: 0, id: "call-1", type: "function", function: drafting ? { name: "draft_reply", arguments: '{"emailId":"email-1","body":"Tuesday works for me.","replyAll":false}' } : { name: "list_emails", arguments: '{"folder":"inbox","limit":20}' } }] });
			chunk({}, "tool_calls");
		}
		response.end("data: [DONE]\n\n");
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	t.after(() => server.close());
	const address = server.address();
	const env = { DB: database, BUCKET: { get: async () => null, delete: async () => {} }, AI_BASE_URL: `http://127.0.0.1:${address.port}/v1`, AI_API_KEY: "test-key", AI_MODEL: "test-model" };
	const context = { env, user: { id: "user-1", email: "owner@example.com", role: "user" }, mailboxId: "mailbox-1", origin: "chat" };

	const direct = { ...context, origin: "mcp" };
	const listed = await runEmailTool(context, "list_emails", { folder: "inbox", limit: 20 });
	assert.equal(listed.emails[0].id, "email-1");
	const email = await runEmailTool(context, "get_email", { emailId: "email-1" });
	assert.match(email.text, /meet Tuesday/);
	const thread = await runEmailTool(context, "get_thread", { emailId: "email-1" });
	assert.equal(thread.emails.length, 1);
	const searched = await runEmailTool(context, "search_emails", { query: "Tuesday", limit: 20 });
	assert.equal(searched.emails[0].id, "email-1");
	const draft = await runEmailTool(context, "draft_reply", { emailId: "email-1", body: "Tuesday works for me.", replyAll: false });
	assert.equal(draft.status, "draft_created");
	const saved = database.db.prepare("SELECT to_addr, text_body, status, private_draft, in_reply_to FROM messages WHERE id = ?").get(draft.draftId);
	assert.equal(saved.to_addr, "customer@example.net");
	assert.equal(saved.text_body, "Tuesday works for me.");
	assert.equal(saved.status, "draft");
	assert.equal(saved.private_draft, 1);
	assert.equal(saved.in_reply_to, "<email-1@example.net>");
	assert.equal(database.db.prepare("SELECT count(*) AS count FROM agent_send_approvals").get().count, 0);
	const newDraft = await runEmailTool(context, "draft_email", { to: "customer@example.net", subject: "Follow up", body: "Hello again." });
	assert.deepEqual({ ...database.db.prepare("SELECT status, private_draft FROM messages WHERE id = ?").get(newDraft.draftId) }, { status: "draft", private_draft: 1 });
	const pendingDiscard = await runEmailTool(context, "discard_draft", { draftId: newDraft.draftId, expectedRevision: 1 });
	assert.equal(pendingDiscard.status, "pending_approval");
	assert.ok(database.db.prepare("SELECT id FROM messages WHERE id = ?").get(newDraft.draftId));
	await runEmailTool(direct, "discard_draft", { draftId: newDraft.draftId, expectedRevision: 1 });
	assert.equal(database.db.prepare("SELECT id FROM messages WHERE id = ?").get(newDraft.draftId), undefined);
	await runEmailTool(direct, "mark_email_read", { emailId: "email-1", read: true });
	assert.equal(database.db.prepare("SELECT read FROM messages WHERE id = 'email-1'").get().read, 1);
	await runEmailTool(direct, "move_email", { emailId: "email-1", destination: "archived" });
	assert.equal(database.db.prepare("SELECT status FROM messages WHERE id = 'email-1'").get().status, "archived");
	await runEmailTool(direct, "move_email", { emailId: "email-1", destination: "inbox" });

	const { stream } = await createAgentChatStream(context, "What arrived in my inbox?");
	const events = (await new Response(stream).text()).trim().split("\n").map((line) => JSON.parse(line));
	assert.ok(events.some((event) => event.type === "tool" && event.name === "list_emails" && event.state === "complete"));
	assert.ok(events.some((event) => event.type === "text" && event.text.includes("one email")));
	assert.equal(events.at(-1).type, "done");
	const drafted = await createAgentChatStream(context, "Draft a reply to email email-1");
	const draftEvents = (await new Response(drafted.stream).text()).trim().split("\n").map((line) => JSON.parse(line));
	assert.ok(draftEvents.some((event) => event.type === "tool" && event.name === "draft_reply" && event.state === "complete" && event.result.draftId));
	assert.equal(database.db.prepare("SELECT count(*) AS count FROM agent_send_approvals").get().count, 0);
	globalThis.__mailflareNodeEnv = env;
	t.after(() => { delete globalThis.__mailflareNodeEnv; });
	const token = await createSession(env, "user-1");
	const request = new Request("http://mailflare.local/api/agent/chat", { method: "POST", headers: { Origin: "http://mailflare.local", Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ mailboxId: "mailbox-1", text: "What arrived in my inbox?" }) });
	const routeResponse = await postAgentChat(request);
	assert.equal(routeResponse.status, 200);
	const routeEvents = (await routeResponse.text()).trim().split("\n").map((line) => JSON.parse(line));
	assert.ok(routeEvents.some((event) => event.type === "tool" && event.name === "list_emails" && event.state === "complete"));
	const bindingEnv = { ...env, AI: { run: async (_model, input) => ({ choices: [{ message: input.messages.some((message) => message.role === "tool") ? { role: "assistant", content: "I found one email in your inbox." } : { role: "assistant", content: null, tool_calls: [{ id: "binding-call-1", type: "function", function: { name: "list_emails", arguments: '{"folder":"inbox","limit":20}' } }] }, finish_reason: input.messages.some((message) => message.role === "tool") ? "stop" : "tool_calls" }] }) } };
	const bindingChat = await createAgentChatStream({ ...context, env: bindingEnv }, "What arrived in my inbox?");
	const bindingEvents = (await new Response(bindingChat.stream).text()).trim().split("\n").map((line) => JSON.parse(line));
	assert.ok(bindingEvents.some((event) => event.type === "tool" && event.name === "list_emails" && event.state === "complete"));
	assert.ok(bindingEvents.some((event) => event.type === "text" && event.text.includes("one email")));
	await assert.rejects(requestAgentSend(env, context.user, draft.draftId, 2), /Draft changed/);
	const approval = await requestAgentSend(env, context.user, draft.draftId, 1);
	assert.equal(approval.status, "pending_approval");
	assert.equal(database.db.prepare("SELECT status FROM agent_send_approvals WHERE id = ?").get(approval.approvalId).status, "pending");
});

async function paginationContext(t) {
	const database = new SqliteDatabase(":memory:");
	t.after(() => database.db.close());
	await applyMigrations(database, join(root, "drizzle", "migrations"));
	database.db.exec(`
		INSERT INTO users (id, email, password_hash, name, created_at) VALUES
			('user-1', 'owner@example.com', 'hash', 'Owner', 1),
			('user-2', 'other@example.com', 'hash', 'Other', 1);
		INSERT INTO domains (id, user_id, hostname, zone_id, status, created_at) VALUES ('domain-1', 'user-1', 'example.com', 'zone-1', 'active', 1);
		INSERT INTO mailboxes (id, user_id, domain_id, local_part, created_at) VALUES
			('mailbox-1', 'user-1', 'domain-1', 'owner', 1),
			('mailbox-2', 'user-2', 'domain-1', 'other', 1);
		INSERT INTO messages (id, user_id, mailbox_id, direction, from_addr, to_addr, subject, text_body, status, private_draft, created_at) VALUES
			('email-1', 'user-1', 'mailbox-1', 'inbound', 'sender@example.net', 'owner@example.com', 'First', 'First email', 'received', 0, 2),
			('email-2', 'user-1', 'mailbox-1', 'inbound', 'sender@example.net', 'owner@example.com', 'Second', 'Second email', 'received', 0, 3),
			('email-3', 'user-1', 'mailbox-1', 'inbound', 'sender@example.net', 'owner@example.com', 'Third', 'Third email', 'received', 0, 4),
			('foreign-email', 'user-2', 'mailbox-2', 'inbound', 'sender@example.net', 'other@example.com', 'Other mailbox', 'Private', 'received', 0, 5),
			('private-draft', 'user-2', 'mailbox-1', 'outbound', 'owner@example.com', 'sender@example.net', 'Other user draft', 'Private', 'draft', 1, 6);
	`);
	return { env: { DB: database }, user: { id: "user-1", email: "owner@example.com", role: "user" }, mailboxId: "mailbox-1", origin: "chat" };
}

test("email pagination starts with an omitted or null cursor and follows returned cursors", async (t) => {
	const context = await paginationContext(t);
	const first = await runEmailTool(context, "list_emails", { folder: "inbox", limit: 1 });
	assert.deepEqual(first.emails.map((email) => email.id), ["email-3"]);
	assert.equal(first.nextCursor, "email-3");
	assert.deepEqual(await runEmailTool(context, "list_emails", { folder: "inbox", limit: 1, cursor: null }), first);
	const second = await runEmailTool(context, "list_emails", { folder: "inbox", limit: 1, cursor: first.nextCursor });
	assert.deepEqual(second.emails.map((email) => email.id), ["email-2"]);
	const third = await runEmailTool(context, "list_emails", { folder: "inbox", limit: 1, cursor: second.nextCursor });
	assert.deepEqual(third.emails.map((email) => email.id), ["email-1"]);
	assert.equal(third.nextCursor, null);
	assert.deepEqual(await runEmailTool(context, "list_emails", { folder: "inbox", limit: 1, cursor: "email-1" }), { emails: [], nextCursor: null });
});

test("email pagination rejects invented and inaccessible cursors with retry guidance", async (t) => {
	const context = await paginationContext(t);
	for (const cursor of ["0", "initial", "missing-email", "foreign-email", "private-draft"]) {
		await assert.rejects(runEmailTool(context, "list_emails", { folder: "inbox", limit: 1, cursor }), (error) => {
			assert.match(error.message, /Invalid pagination cursor/);
			assert.match(error.message, /omit cursor|omit the cursor/i);
			assert.match(error.message, /null/);
			assert.match(error.message, /nextCursor/);
			return true;
		});
	}
	await assert.rejects(runEmailTool(context, "get_email", { emailId: "missing-email" }), /Message not found/);
	await assert.rejects(runEmailTool({ ...context, mailboxId: "mailbox-2" }, "list_emails", { folder: "inbox", cursor: "foreign-email" }), /Mailbox not found or permission denied/);
});

test("chat receives pagination correction guidance and can retry with a null cursor", async (t) => {
	const context = await paginationContext(t);
	const requests = [];
	const server = createServer(async (request, response) => {
		let raw = "";
		for await (const chunk of request) raw += chunk;
		const body = JSON.parse(raw);
		requests.push(body);
		const results = body.messages.filter((message) => message.role === "tool");
		response.writeHead(200, { "Content-Type": "text/event-stream" });
		const chunk = (delta, finishReason = null) => response.write(`data: ${JSON.stringify({ id: "pagination-mock", object: "chat.completion.chunk", created: 1, model: "test-model", choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`);
		const canRetry = results.length === 1 && results[0].content.includes("Invalid pagination cursor") && results[0].content.includes("null");
		if (results.length === 0 || canRetry) {
			chunk({ role: "assistant", tool_calls: [{ index: 0, id: `pagination-call-${results.length}`, type: "function", function: { name: "list_emails", arguments: JSON.stringify({ folder: "inbox", limit: 1, cursor: canRetry ? null : "0" }) } }] });
			chunk({}, "tool_calls");
		} else {
			chunk({ role: "assistant", content: results.length === 2 ? "The most recent email is Third." : "Unable to list emails." });
			chunk({}, "stop");
		}
		response.end("data: [DONE]\n\n");
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	t.after(() => server.close());
	context.env = { ...context.env, AI_BASE_URL: `http://127.0.0.1:${server.address().port}/v1`, AI_API_KEY: "test-key", AI_MODEL: "test-model" };
	const { stream } = await createAgentChatStream(context, "List my most recent email.");
	const events = (await new Response(stream).text()).trim().split("\n").map((line) => JSON.parse(line));
	const failed = events.find((event) => event.type === "tool" && event.name === "list_emails" && event.state === "failed");
	assert.match(failed?.result ?? "", /Invalid pagination cursor/);
	const listed = events.find((event) => event.type === "tool" && event.name === "list_emails" && event.state === "complete");
	assert.deepEqual(listed?.result.emails.map((email) => email.id), ["email-3"]);
	assert.ok(events.some((event) => event.type === "text" && event.text.includes("Third")));
	assert.equal(requests.length, 3);
	// Inspect the actual tool arguments replayed to the provider between steps.
	assert.equal(JSON.parse(requests[1].messages.find((message) => message.tool_calls?.length).tool_calls[0].function.arguments).cursor, "0");
	assert.equal(JSON.parse(requests[2].messages.filter((message) => message.tool_calls?.length).at(-1).tool_calls[0].function.arguments).cursor, null);
});

test("email pagination does not skip messages that share a created_at second", async (t) => {
	const context = await paginationContext(t);
	context.env.DB.db.exec(`
		INSERT INTO messages (id, user_id, mailbox_id, direction, from_addr, to_addr, subject, text_body, status, created_at) VALUES
			('tie-a', 'user-1', 'mailbox-1', 'inbound', 'sender@example.net', 'owner@example.com', 'A', 'a', 'received', 10),
			('tie-b', 'user-1', 'mailbox-1', 'inbound', 'sender@example.net', 'owner@example.com', 'B', 'b', 'received', 10),
			('tie-c', 'user-1', 'mailbox-1', 'inbound', 'sender@example.net', 'owner@example.com', 'C', 'c', 'received', 10);
	`);
	const ids = [];
	let cursor = null;
	do {
		const page = await runEmailTool(context, "list_emails", { folder: "inbox", limit: 1, cursor });
		ids.push(...page.emails.map((email) => email.id));
		cursor = page.nextCursor;
	} while (cursor);
	assert.deepEqual(ids, ["tie-c", "tie-b", "tie-a", "email-3", "email-2", "email-1"]);
});

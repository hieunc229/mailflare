import assert from "node:assert/strict";
import test from "node:test";
import { loadApp, sharedMailboxSeed } from "./helpers/real-db.mjs";

// Another user's draft that its author filed under Archive or a folder is still private: the
// thread view, the list's conversation counts, Drive's attachment list and the auto-draft prompt
// must all leave it out, for everyone but its author.
const mocks = {
	"@/lib/cloudflare": "export function getEnv(){return globalThis.prEnv}",
	"@/lib/auth/cookies": "export async function getCurrentUser(){return globalThis.prUser} export async function requireUser(){return globalThis.prUser}",
	ai: "export async function generateText(o){globalThis.prPrompt=o.prompt;return {text:''}}",
	"../model": "export async function getAgentModel(){return {model:{}}}",
	"../provider": "export async function getAgentEnabled(){return true}",
	"../tools": "export async function runEmailTool(){return {draftId:'x'}}",
	"@/lib/ai/usage": "export async function recordAiUsage(){}",
};
const { app, newDatabase } = await loadApp("private-draft-readers", `
	export { getMessageThreadForUser } from "./src/lib/email/thread-view.ts";
	export { listDriveAttachments } from "./src/lib/drive/attachments.ts";
	export { processAgentDraftJob } from "./src/lib/agent/jobs/utils.ts";
	export * as list from "./src/app/api/messages/route.ts";
`, { mocks });

const seed = `${sharedMailboxSeed("send_on_behalf")}
	INSERT INTO messages (id, user_id, mailbox_id, direction, from_addr, to_addr, subject, text_body, status, private_draft, thread_id, created_at) VALUES
		('in-1', 'admin', 'mb-team', 'inbound', 'x@example.net', 'team@example.com', 'Hello', 'visible question', 'received', 0, 'th', 2),
		('d-arch', 'author', 'mb-team', 'outbound', 'team@example.com', 'x@example.net', 'Re: Hello', 'SECRET-DRAFT', 'archived', 1, 'th', 3);
	INSERT INTO message_attachments (id, message_id, filename, content_type, size, disposition, r2_key, created_at) VALUES
		('att-d', 'd-arch', 'secret.pdf', 'application/pdf', 1, 'attachment', 'k1', 1),
		('att-v', 'in-1', 'ok.pdf', 'application/pdf', 1, 'attachment', 'k2', 1);
	INSERT INTO mailbox_agent_settings (mailbox_id, enabled, auto_draft_enabled, reviewer_user_id, instructions, daily_limit, updated_at) VALUES ('mb-team', 1, 1, 'delegate', '', 25, 1);
	INSERT INTO agent_jobs (id, mailbox_id, source_message_id, reviewer_user_id, status, next_attempt_at, created_at) VALUES ('job-1', 'mb-team', 'in-1', 'delegate', 'pending', 1, 1);
`;
const user = (id) => ({ id, email: `${id}@example.com`, role: "user" });
async function setup(t, who) {
	const fixture = await newDatabase(t, seed);
	globalThis.prEnv = fixture.env;
	globalThis.prUser = user(who);
	return fixture;
}

test("the thread view leaves out another user's archived draft", async (t) => {
	const { env } = await setup(t, "delegate");
	const ids = (await app.getMessageThreadForUser(env, user("delegate"), "in-1")).messages.map((m) => m.id);
	assert.deepEqual(ids, ["in-1"]);
	// The filter must not hide the author's own rows.
	const own = await app.getMessageThreadForUser(env, user("author"), "in-1");
	assert.ok(own.messages.some((m) => m.id === "in-1"));
});

test("conversation counts in the list exclude another user's archived draft", async (t) => {
	await setup(t, "delegate");
	const body = await (await app.list.GET(new Request("http://localhost/api/messages?mailboxId=mb-team&status=received"))).json();
	assert.equal(body.messages.find((m) => m.id === "in-1").threadCount, 1);
	globalThis.prUser = user("author");
	const mine = await (await app.list.GET(new Request("http://localhost/api/messages?mailboxId=mb-team&status=received"))).json();
	assert.equal(mine.messages.find((m) => m.id === "in-1").threadCount, 2);
});

test("Drive lists attachments of visible mail, not of another user's archived draft", async (t) => {
	const { db } = await setup(t, "delegate");
	const names = async (id) => (await app.listDriveAttachments(db, user(id), [])).map((item) => item.name).sort();
	assert.deepEqual(await names("delegate"), ["ok.pdf"]);
	assert.deepEqual(await names("author"), ["ok.pdf", "secret.pdf"]);
});

test("the auto-draft prompt does not quote another user's archived draft", async (t) => {
	const { env } = await setup(t, "delegate");
	globalThis.prPrompt = undefined;
	await app.processAgentDraftJob(env, "job-1");
	assert.ok(globalThis.prPrompt, "the model was called");
	assert.match(globalThis.prPrompt, /visible question/);
	assert.doesNotMatch(globalThis.prPrompt, /SECRET-DRAFT/);
});

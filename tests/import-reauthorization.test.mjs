import assert from "node:assert/strict";
import test from "node:test";
import { loadApp, sharedMailboxSeed } from "./helpers/real-db.mjs";

const { app, newDatabase } = await loadApp("import-reauth", `export { processImportJob, resumeImportJob } from "./src/lib/import/jobs.ts";`);

const job = (status) => `
	INSERT INTO import_jobs (id, user_id, mailbox_id, kind, label, status, spec, cursor, created_at, updated_at)
	VALUES ('job-1', 'delegate', 'mb-team', 'file', 'mail.mbox', '${status}', '{"destination":"inbox","batches":1}', '{"batch":0}', 1, 1);
`;
const state = (sqlite) => ({ ...sqlite.prepare("SELECT status, error FROM import_jobs WHERE id = 'job-1'").get() });
const noObjects = { head: async () => null, get: async () => null, delete: async () => {} };

test("a running import stops once its owner loses access to the mailbox", async (t) => {
	const { env, sqlite } = await newDatabase(t, sharedMailboxSeed("full_access") + job("queued"));
	env.BUCKET = noObjects;
	sqlite.exec("DELETE FROM mailbox_access WHERE user_id = 'delegate'");
	await app.processImportJob(env, { kind: "import.run", jobId: "job-1" });
	assert.deepEqual(state(sqlite), { status: "failed", error: "You no longer have access to this mailbox" });
});

test("a disabled owner's import stops too", async (t) => {
	const { env, sqlite } = await newDatabase(t, sharedMailboxSeed("full_access") + job("queued"));
	env.BUCKET = noObjects;
	sqlite.exec("UPDATE users SET disabled = 1 WHERE id = 'delegate'");
	await app.processImportJob(env, { kind: "import.run", jobId: "job-1" });
	assert.equal(state(sqlite).error, "You no longer have access to this mailbox");
});

test("an owner who still manages the mailbox is not blocked by the check", async (t) => {
	const { env, sqlite } = await newDatabase(t, sharedMailboxSeed("full_access") + job("queued"));
	env.BUCKET = noObjects;
	await app.processImportJob(env, { kind: "import.run", jobId: "job-1" });
	// The staged upload is missing in this stub, which is a different failure from the access check.
	assert.match(state(sqlite).error, /Uploaded files are no longer available/);
});

test("a failed import cannot be resumed after access is revoked", async (t) => {
	const { env, sqlite } = await newDatabase(t, sharedMailboxSeed("send_on_behalf") + job("failed"));
	env.BUCKET = noObjects;
	const result = await app.resumeImportJob(env, "delegate", "job-1");
	assert.deepEqual(result, { ok: false, status: 409, error: "You no longer have access to this mailbox" });
	assert.equal(state(sqlite).status, "failed");
});

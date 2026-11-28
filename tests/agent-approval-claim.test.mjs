import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadApp } from "./helpers/real-db.mjs";

const { app, newDatabase } = await loadApp("agent-approval-claim", 'export { claimAgentApproval } from "./src/lib/agent/approvals/claim.ts";');

async function setup(t, rows) {
	const fixture = await newDatabase(t);
	const { sqlite } = fixture;
	sqlite.pragma("foreign_keys = OFF");
	sqlite.exec("DROP INDEX agent_send_approvals_delivery_idx");
	const insert = sqlite.prepare("INSERT INTO agent_send_approvals (id, draft_id, mailbox_id, user_id, revision, payload_hash, status, expires_at, created_at) VALUES (?, ?, 'mb', 'u', 1, 'h', ?, 9999999999, 1)");
	for (const [id, draft, status] of rows) insert.run(id, draft, status);
	return fixture;
}
const row = (sqlite, id) => sqlite.prepare("SELECT status, claimed_at FROM agent_send_approvals WHERE id = ?").get(id);

test("the first claim wins and the second backs out", async (t) => {
	const { db, sqlite } = await setup(t, [["a1", "d1", "pending"], ["a2", "d1", "pending"]]);
	assert.equal(await app.claimAgentApproval(db, "a1", "d1"), "claimed");
	assert.equal(await app.claimAgentApproval(db, "a2", "d1"), "in_progress");
	assert.equal(row(sqlite, "a1").status, "claimed");
	assert.equal(row(sqlite, "a2").status, "pending");
	assert.equal(row(sqlite, "a2").claimed_at, null);
});

for (const status of ["sent", "unknown"]) {
	test(`a ${status} approval blocks a new claim`, async (t) => {
		const { db, sqlite } = await setup(t, [["a1", "d1", status], ["a2", "d1", "pending"]]);
		assert.equal(await app.claimAgentApproval(db, "a2", "d1"), "in_progress");
		assert.equal(row(sqlite, "a1").status, status);
	});
}

test("the partial unique index refusing the claim reads as in progress", async (t) => {
	const fixture = await newDatabase(t);
	const { db, sqlite } = fixture;
	sqlite.pragma("foreign_keys = OFF");
	const insert = sqlite.prepare("INSERT INTO agent_send_approvals (id, draft_id, mailbox_id, user_id, revision, payload_hash, status, expires_at, created_at) VALUES (?, ?, 'mb', 'u', 1, 'h', ?, 9999999999, 1)");
	insert.run("a1", "d1", "claimed");
	insert.run("a2", "d1", "pending");
	assert.equal(await app.claimAgentApproval(db, "a2", "d1"), "in_progress");
	assert.equal(row(sqlite, "a2").status, "pending");
});

test("a non-pending approval is not claimed", async (t) => {
	const { db } = await setup(t, [["a1", "d1", "expired"]]);
	assert.equal(await app.claimAgentApproval(db, "a1", "d1"), "not_pending");
});

test("other drafts do not interfere", async (t) => {
	const { db } = await setup(t, [["a1", "d1", "pending"], ["a2", "d2", "claimed"]]);
	assert.equal(await app.claimAgentApproval(db, "a1", "d1"), "claimed");
});

test("confirmAgentSend claims through claimAgentApproval", () => {
	const src = readFileSync("src/lib/agent/approvals/utils.ts", "utf8");
	assert.match(src, /claimAgentApproval\(db, approvalId, approval\.draftId\)/);
	assert.doesNotMatch(src, /status: "claimed", claimedAt: new Date\(\)/);
});

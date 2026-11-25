import assert from "node:assert/strict";
import test from "node:test";
import { loadApp } from "./helpers/real-db.mjs";

const { newDatabase } = await loadApp("messages-redundant-indexes", "");

const DROPPED = ["messages_inbox_page_idx", "messages_mailbox_idx"];

// Queries that used to be served by the dropped indexes (mailbox_id equality, with or without the
// status/folder/created_at page order, and the ON DELETE SET NULL lookup from mailboxes).
const QUERIES = {
	"mailbox_id only (counts, delete, FK set null)": "SELECT id FROM messages WHERE mailbox_id = 'm'",
	"mailbox_id IN list": "SELECT id FROM messages WHERE mailbox_id IN ('m', 'n')",
	"delete by mailbox": "DELETE FROM messages WHERE mailbox_id = 'm'",
	"mailbox + status": "SELECT id FROM messages WHERE mailbox_id = 'm' AND status = 'received'",
	"inbox page order": "SELECT id FROM messages WHERE mailbox_id = 'm' AND status = 'received' AND folder_id = 'f' ORDER BY created_at DESC, id DESC LIMIT 50",
	"inbox page keyset": "SELECT id FROM messages WHERE mailbox_id = 'm' AND status = 'received' AND folder_id = 'f' AND (created_at < 5 OR (created_at = 5 AND id < 'x')) ORDER BY created_at DESC, id DESC LIMIT 50",
};

test("redundant message indexes are gone", async (t) => {
	const { sqlite } = await newDatabase(t);
	const names = sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'messages'").all().map((r) => r.name);
	for (const name of DROPPED) assert.equal(names.includes(name), false, `${name} still exists`);
	// Covering replacements stay.
	for (const name of ["messages_nav_cover_idx", "messages_thread_idx"]) assert.ok(names.includes(name), `${name} missing`);
});

test("mailbox_id queries are still served by another index, not a full scan", async (t) => {
	const { sqlite } = await newDatabase(t);
	for (const [label, sql] of Object.entries(QUERIES)) {
		const plan = sqlite.prepare(`EXPLAIN QUERY PLAN ${sql}`).all().map((r) => r.detail).join(" | ");
		assert.match(plan, /SEARCH messages USING (COVERING )?INDEX messages_\w+_idx \(mailbox_id/, `${label}: ${plan}`);
		for (const name of DROPPED) assert.equal(plan.includes(name), false, `${label} uses dropped ${name}`);
	}
});

test("inbox page order needs no sort", async (t) => {
	const { sqlite } = await newDatabase(t);
	const plan = sqlite.prepare(`EXPLAIN QUERY PLAN ${QUERIES["inbox page order"]}`).all().map((r) => r.detail).join(" | ");
	assert.equal(/TEMP B-TREE/.test(plan), false, plan);
});

test("another index leads with mailbox_id (MySQL FK needs one)", async (t) => {
	const { sqlite } = await newDatabase(t);
	const names = sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'messages'").all().map((r) => r.name);
	const leading = names.filter((n) => sqlite.prepare(`SELECT name FROM pragma_index_info('${n}') WHERE seqno = 0`).get()?.name === "mailbox_id");
	assert.ok(leading.length >= 1, "no index leads with mailbox_id");
});

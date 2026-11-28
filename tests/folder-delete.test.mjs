import assert from "node:assert/strict";
import test from "node:test";
import { loadApp, sharedMailboxSeed } from "./helpers/real-db.mjs";

const mocks = {
	"@/lib/cloudflare": "export function getEnv(){return globalThis.folderEnv}",
	"@/lib/auth/cookies": "export async function requireUser(){return globalThis.folderUser}",
	"@/lib/api/auth": "export async function requireSessionUser(){return globalThis.folderUser?{user:globalThis.folderUser,error:null}:{user:null,error:Response.json({error:'Unauthorized'},{status:401})}}",
};
const { app, newDatabase } = await loadApp("folder-delete", `export * as folders from "./src/app/api/folders/route.ts";`, { mocks });

const seed = (permission) => `${sharedMailboxSeed(permission)}
	INSERT INTO folders (id, user_id, mailbox_id, name, color, created_at) VALUES
		('fld-team', 'admin', 'mb-team', 'Receipts', '#2563eb', 1),
		('fld-team-2', 'admin', 'mb-team', 'Travel', '#2563eb', 1),
		('fld-other', 'delegate', 'mb-delegate', 'Private', '#2563eb', 1);
	INSERT INTO messages (id, user_id, mailbox_id, direction, from_addr, to_addr, subject, text_body, status, folder_id, created_at) VALUES
		('m-1', 'admin', 'mb-team', 'inbound', 'x@example.net', 'team@example.com', 'A', 'a', 'received', 'fld-team', 2),
		('m-2', 'admin', 'mb-team', 'inbound', 'x@example.net', 'team@example.com', 'B', 'b', 'received', 'fld-team', 3),
		('m-3', 'admin', 'mb-team', 'inbound', 'x@example.net', 'team@example.com', 'C', 'c', 'received', 'fld-team-2', 4);
`;
const user = (id) => ({ id, email: `${id}@example.com`, role: "user" });
const del = (id, mailboxId = "mb-team") => app.folders.DELETE(new Request(`http://localhost/api/folders?id=${id}&mailboxId=${mailboxId}`, { method: "DELETE" }));
const patch = (body) => app.folders.PATCH(new Request("http://localhost/api/folders", { method: "PATCH", body: JSON.stringify(body) }));
async function setup(t, who, permission = "read_only") {
	const made = await newDatabase(t, seed(permission));
	globalThis.folderEnv = made.env;
	globalThis.folderUser = who ? user(who) : null;
	return made.sqlite;
}
const names = (sqlite) => sqlite.prepare("SELECT id, name FROM folders ORDER BY id").all().map((r) => `${r.id}=${r.name}`);
const ALL = ["fld-other=Private", "fld-team=Receipts", "fld-team-2=Travel"];

test("deleting a folder moves its messages to the inbox and leaves other folders alone", async (t) => {
	const sqlite = await setup(t, "admin");
	sqlite.prepare("UPDATE messages SET snoozed_until = 9999999999999 WHERE id = 'm-2'").run();
	const response = await del("fld-team");
	assert.equal(response.status, 200);
	assert.equal((await response.json()).moved, 2);
	assert.deepEqual(names(sqlite), ["fld-other=Private", "fld-team-2=Travel"]);
	const rows = sqlite.prepare("SELECT id, status, folder_id, snoozed_until FROM messages ORDER BY id").all();
	assert.deepEqual(rows.map((r) => `${r.id}:${r.status}:${r.folder_id}:${r.snoozed_until}`), ["m-1:received:null:null", "m-2:received:null:9999999999999", "m-3:received:fld-team-2:null"]);
});

test("delete needs a signed-in user and both ids", async (t) => {
	const sqlite = await setup(t, null);
	assert.equal((await del("fld-team")).status, 401);
	globalThis.folderUser = user("admin");
	assert.equal((await app.folders.DELETE(new Request("http://localhost/api/folders?mailboxId=mb-team", { method: "DELETE" }))).status, 400);
	assert.equal((await app.folders.DELETE(new Request("http://localhost/api/folders?id=fld-team", { method: "DELETE" }))).status, 400);
	assert.deepEqual(names(sqlite), ALL);
});

test("system folders have no folder row and cannot be deleted", async (t) => {
	const sqlite = await setup(t, "admin");
	for (const id of ["inbox", "sent", "drafts", "trash", "spam", "archived", "starred", "snoozed"]) {
		assert.equal((await del(id)).status, 404, id);
	}
	assert.deepEqual(names(sqlite), ALL);
});

test("a folder cannot be deleted through another mailbox or another user's mailbox", async (t) => {
	const sqlite = await setup(t, "admin");
	assert.equal((await del("fld-other", "mb-team")).status, 404);
	assert.equal((await del("fld-other", "mb-delegate")).status, 404);
	assert.deepEqual(names(sqlite), ALL);
	assert.equal(sqlite.prepare("SELECT count(*) n FROM messages WHERE folder_id = 'fld-team'").get().n, 2);
});

test("read-only and send-only sharees cannot delete a shared folder; full_access can", async (t) => {
	for (const permission of ["read_only", "send_as", "send_on_behalf"]) {
		const sqlite = await setup(t, "delegate", permission);
		assert.equal((await del("fld-team")).status, 404, permission);
		assert.deepEqual(names(sqlite), ALL, permission);
		assert.equal(sqlite.prepare("SELECT count(*) n FROM messages WHERE folder_id = 'fld-team'").get().n, 2, permission);
	}
	const sqlite = await setup(t, "delegate", "full_access");
	assert.equal((await del("fld-team")).status, 200);
	assert.deepEqual(names(sqlite), ["fld-other=Private", "fld-team-2=Travel"]);
});

test("delete lands in the JMAP change log", async (t) => {
	const sqlite = await setup(t, "admin");
	sqlite.prepare("DELETE FROM jmap_changes").run();
	await del("fld-team");
	const log = sqlite.prepare("SELECT object_type, object_id, change FROM jmap_changes ORDER BY seq").all().map((r) => `${r.object_type}/${r.object_id}/${r.change}`);
	assert.deepEqual(log.sort(), ["email/m-1/updated", "email/m-2/updated", "mailbox/fld-team/destroyed"]);
});

test("a folder that inbox rules file into cannot be deleted until the rules are changed", async (t) => {
	const sqlite = await setup(t, "admin");
	sqlite.prepare(`INSERT INTO routing_rules (id, user_id, domain_id, pattern, mailbox_id, action, priority, created_at, name, folder_id)
		VALUES ('rule-1', 'admin', 'domain-1', '*', 'mb-team', 'store', 0, 1, 'Receipts rule', 'fld-team')`).run();
	const response = await del("fld-team");
	assert.equal(response.status, 409);
	assert.match((await response.json()).error, /Receipts rule/);
	assert.equal(sqlite.prepare("SELECT count(*) n FROM messages WHERE folder_id = 'fld-team'").get().n, 2);
	sqlite.prepare("DELETE FROM routing_rules").run();
	assert.equal((await del("fld-team")).status, 200);
});

test("losing a rename race to the unique index is a conflict, not a 500", async (t) => {
	const sqlite = await setup(t, "admin");
	sqlite.exec(`CREATE TRIGGER race BEFORE UPDATE OF name ON folders BEGIN
		INSERT INTO folders (id, user_id, mailbox_id, name, color, created_at) VALUES ('fld-race', NEW.user_id, NEW.mailbox_id, NEW.name, '#000', 1);
	END`);
	const response = await patch({ id: "fld-team", mailboxId: "mb-team", name: "Invoices", color: "#2563eb" });
	assert.equal(response.status, 409);
});

import assert from "node:assert/strict";
import test from "node:test";
import { loadApp } from "./helpers/real-db.mjs";

const { app, newDatabase } = await loadApp("mail-groups", `
	export { BACKUP_TABLES } from "./src/lib/backups/export.ts";
	export { BACKUP_TABLE_GROUPS } from "./src/lib/backups/table-groups.ts";
	export { findAddressOwner } from "./src/lib/mailboxes/address-owner.ts";
`);

const seed = `
	INSERT INTO users (id, email, password_hash, name, role, created_at) VALUES
		('u1', 'a@example.com', 'h', 'A', 'admin', 1),
		('u2', 'b@example.com', 'h', 'B', 'user', 1);
	INSERT INTO domains (id, user_id, hostname, zone_id, status, created_at) VALUES ('d1', 'u1', 'example.com', 'z', 'active', 1);
	INSERT INTO mailboxes (id, user_id, domain_id, local_part, type, created_at) VALUES ('m1', 'u2', 'd1', 'b', 'personal', 1);
	INSERT INTO mail_groups (id, domain_id, local_part, name, created_at, updated_at) VALUES ('g1', 'd1', 'team', 'Team', 1, 1);
`;

const member = (id, kind, column, value) =>
	`INSERT INTO mail_group_members (id, group_id, kind, ${column}, created_at) VALUES ('${id}', 'g1', '${kind}', '${value}', 1)`;

test("mail_groups defaults and a unique address per domain", async (t) => {
	const { sqlite } = await newDatabase(t, seed);
	const row = sqlite.prepare("SELECT who_can_post, reply_to, disabled FROM mail_groups WHERE id = 'g1'").get();
	assert.deepEqual({ ...row }, { who_can_post: "anyone", reply_to: "sender", disabled: 0 });
	assert.throws(() => sqlite.exec("INSERT INTO mail_groups (id, domain_id, local_part, name, created_at, updated_at) VALUES ('g2', 'd1', 'team', 'Dup', 1, 1)"), /UNIQUE/);
});

test("members are unique per kind and NULL columns do not collide", async (t) => {
	const { sqlite } = await newDatabase(t, seed);
	sqlite.exec(member("gm1", "user", "user_id", "u1"));
	sqlite.exec(member("gm2", "mailbox", "mailbox_id", "m1"));
	sqlite.exec(member("gm3", "external", "email", "x@ext.com"));
	sqlite.exec(member("gm4", "external", "email", "y@ext.com"));
	assert.throws(() => sqlite.exec(member("gm5", "user", "user_id", "u1")), /UNIQUE/);
	assert.throws(() => sqlite.exec(member("gm6", "mailbox", "mailbox_id", "m1")), /UNIQUE/);
	assert.throws(() => sqlite.exec(member("gm7", "external", "email", "x@ext.com")), /UNIQUE/);
	assert.equal(sqlite.prepare("SELECT can_send_as FROM mail_group_members WHERE id = 'gm1'").get().can_send_as, 0);
});

test("deleting a user, mailbox or group removes their member rows", async (t) => {
	const { sqlite } = await newDatabase(t, seed);
	sqlite.exec("PRAGMA foreign_keys = ON");
	sqlite.exec(member("gm1", "user", "user_id", "u2"));
	sqlite.exec(member("gm2", "mailbox", "mailbox_id", "m1"));
	sqlite.exec(member("gm3", "external", "email", "x@ext.com"));
	sqlite.exec("DELETE FROM mailboxes WHERE id = 'm1'");
	assert.deepEqual(sqlite.prepare("SELECT id FROM mail_group_members ORDER BY id").all().map((r) => r.id), ["gm1", "gm3"]);
	sqlite.exec("DELETE FROM users WHERE id = 'u2'");
	assert.deepEqual(sqlite.prepare("SELECT id FROM mail_group_members ORDER BY id").all().map((r) => r.id), ["gm3"]);
	sqlite.exec("DELETE FROM mail_groups WHERE id = 'g1'");
	assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM mail_group_members").get().n, 0);
});

test("backups list both tables after mailbox_access and in the accounts group", () => {
	const tables = app.BACKUP_TABLES;
	const at = tables.indexOf("mail_groups");
	assert.equal(at, tables.indexOf("mailbox_access") + 1);
	assert.equal(tables[at + 1], "mail_group_members");
	const accounts = app.BACKUP_TABLE_GROUPS.find((group) => group.id === "accounts");
	assert.ok(accounts.tables.includes("mail_groups") && accounts.tables.includes("mail_group_members"));
});

test("findAddressOwner reports a group, normalized, after mailboxes and aliases", async (t) => {
	const { db } = await newDatabase(t, seed);
	assert.equal(await app.findAddressOwner(db, "d1", "team"), "group");
	assert.equal(await app.findAddressOwner(db, "d1", "T.eam+x"), "group");
	assert.equal(await app.findAddressOwner(db, "d1", "b"), "mailbox");
	assert.equal(await app.findAddressOwner(db, "d1", "nobody"), null);
});

test("findAddressOwner ignores groups when the table is not migrated yet", async (t) => {
	const { db, sqlite } = await newDatabase(t, seed);
	sqlite.exec("DROP TABLE mail_group_members; DROP TABLE mail_groups");
	assert.equal(await app.findAddressOwner(db, "d1", "team"), null);
	assert.equal(await app.findAddressOwner(db, "d1", "b"), "mailbox");
});

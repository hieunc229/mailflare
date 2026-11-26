import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test, { after } from "node:test";
import { installSqlite, loadFixture } from "./helpers/fixtures.mjs";

const { migrations } = JSON.parse(readFileSync(new URL("../src/lib/migrations/bundle.json", import.meta.url), "utf8"));
const schema = "PRAGMA foreign_keys = ON;\n" + migrations.flatMap((migration) => migration.statements).join(";\n");
const stub = (names) => names.map((name) => `export const ${name} = () => { throw new Error("${name} is not used here") };`).join("\n");
const fixture = await loadFixture({
	name: "calendar-share-account",
	entryPoint: "src/lib/accounts/deletion.ts",
	mocks: {
		"@/db": "export function getDb(){return globalThis.calAcct.db}",
		"@/lib/auth/admin": "export const canManageUsers = () => true; export const isPrimaryAdmin = () => true;",
		"@/lib/drive/access": stub(["deleteDriveItems"]),
		"@/lib/licenses/seats": stub(["getAccountSeatError"]),
		"@/lib/mailboxes/domain-addresses": stub(["removeMailboxDomainRouting"]),
		"@/app/api/profile/avatar/utils": stub(["avatarKeyFor"]),
		"@/lib/drive/shared-objects": stub(["deleteUnreferencedObjects"]),
	},
});
const { deleteAccounts } = await fixture.import();
let sqlite;
after(() => { sqlite?.close(); delete globalThis.calAcct; fixture.dispose(); });

function setup() {
	sqlite?.close();
	sqlite = installSqlite("calAcct", { schema });
	for (const id of ["u1", "u2", "u3", "u4"]) sqlite.exec(`INSERT INTO users (id, email, name, password_hash, role, created_at) VALUES ('${id}', '${id}@one.test', 'U', 'x', 'user', 1)`);
	sqlite.exec("INSERT INTO dav_collections (id, user_id, kind, display_name, created_at, updated_at) VALUES ('cal:work', 'u1', 'calendar', 'Work', 1, 1), ('cal:u1', 'u1', 'calendar', NULL, 1, 1), ('cal:other', 'u3', 'calendar', 'O', 1, 1)");
	sqlite.exec("INSERT INTO calendar_shares (id, calendar_id, grantee_user_id, role, created_at) VALUES ('a', 'cal:work', 'u2', 'edit', 1), ('b', 'cal:u1', 'u2', 'read', 1), ('c', 'cal:other', 'u1', 'read', 1), ('d', 'cal:other', 'u4', 'read', 1)");
}
const actor = { id: "admin", role: "admin" };
const shares = () => sqlite.prepare("SELECT id FROM calendar_shares ORDER BY id").all().map((row) => row.id);

test("deleting an account removes the grants on its calendars and the grants it holds, and nobody else's", async () => {
	setup();
	const result = await deleteAccounts({}, actor, { ids: ["u1"] });
	assert.equal(result.ok, true);
	assert.deepEqual(shares(), ["d"]);
});

test("deleting an account that hands its calendars to another keeps the grants on the calendars that moved", async () => {
	setup();
	const result = await deleteAccounts({}, actor, { ids: ["u1"], transferToId: "u4" });
	assert.equal(result.ok, true);
	// "a" stays on the moved calendar; "b" was on the default calendar, which stays behind with the deleted account; "c" is held by it.
	assert.deepEqual(shares(), ["a", "d"]);
	assert.equal(sqlite.prepare("SELECT user_id FROM dav_collections WHERE id = 'cal:work'").get().user_id, "u4");
});

test("purging an account row cascades its calendars' grants and its own", () => {
	setup();
	sqlite.exec("DELETE FROM users WHERE id = 'u1'");
	assert.deepEqual(shares(), ["d"]);
});

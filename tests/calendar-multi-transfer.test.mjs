import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test, { after } from "node:test";
import { installSqlite, loadFixture } from "./helpers/fixtures.mjs";

const { migrations } = JSON.parse(readFileSync(new URL("../src/lib/migrations/bundle.json", import.meta.url), "utf8"));
const schema = "PRAGMA foreign_keys = ON;\n" + migrations.flatMap((migration) => migration.statements).join(";\n");
const stub = (names) => names.map((name) => `export const ${name} = () => { throw new Error("${name} is not used by a transfer") };`).join("\n");
const fixture = await loadFixture({
	name: "calendar-multi-transfer",
	entryPoint: "src/lib/accounts/deletion.ts",
	mocks: {
		"@/db": "export function getDb(){return globalThis.calTransfer.db}",
		"@/lib/auth/admin": stub(["canManageUsers", "isPrimaryAdmin"]),
		"@/lib/drive/access": stub(["deleteDriveItems"]),
		"@/lib/licenses/seats": stub(["getAccountSeatError"]),
		"@/lib/mailboxes/domain-addresses": stub(["removeMailboxDomainRouting"]),
		"@/app/api/profile/avatar/utils": stub(["avatarKeyFor"]),
		"@/lib/drive/shared-objects": stub(["deleteUnreferencedObjects"]),
	},
});
const { transferAccountData } = await fixture.import();
let sqlite;
after(() => { sqlite?.close(); delete globalThis.calTransfer; fixture.dispose(); });

test("transferring an account moves its extra calendars with their events and drops the recipient's grants on them", async () => {
	sqlite = installSqlite("calTransfer", { schema });
	for (const id of ["u1", "u2"]) sqlite.exec(`INSERT INTO users (id, email, name, password_hash, role, created_at) VALUES ('${id}', '${id}@one.test', 'U', 'x', 'user', 1)`);
	sqlite.exec("INSERT INTO dav_collections (id, user_id, kind, display_name, created_at, updated_at) VALUES ('cal:work', 'u1', 'calendar', 'Work', 1, 1), ('cal:u1', 'u1', 'calendar', 'Mine', 1, 1)");
	sqlite.exec("INSERT INTO calendar_shares (id, calendar_id, grantee_user_id, role, created_at) VALUES ('csh_1', 'cal:work', 'u2', 'edit', 1), ('csh_2', 'cal:work', NULL, 'read', 1)");
	const event = (id, calendarId) => sqlite.prepare("INSERT INTO calendar_events (id, user_id, calendar_id, title, starts_at, ends_at, created_at, updated_at) VALUES (?, 'u1', ?, 'E', 1, 2, 1, 1)").run(id, calendarId);
	event("w1", "cal:work"); event("d1", null); event("d2", "cal:u1");
	await transferAccountData({}, "u1", "Ayaan", "u2");
	assert.equal(sqlite.prepare("SELECT user_id FROM dav_collections WHERE id = 'cal:work'").get().user_id, "u2");
	assert.deepEqual(sqlite.prepare("SELECT id, user_id, calendar_id FROM calendar_events ORDER BY id").all().map((row) => [row.id, row.user_id, row.calendar_id]), [["d1", "u2", null], ["d2", "u2", null], ["w1", "u2", "cal:work"]]);
	assert.deepEqual(sqlite.prepare("SELECT id FROM calendar_shares").all().map((row) => row.id), ["csh_2"]);
	// The change log: the moved calendar's events stay in their collection; the default ones leave cal:u1 for cal:u2.
	const destroyed = sqlite.prepare("SELECT collection_id AS c, object_key AS k FROM dav_changes WHERE change_type = 'destroyed' ORDER BY seq").all().map((row) => [row.c, row.k]);
	assert.deepEqual(destroyed, [["cal:u1", "d1"], ["cal:u1", "d2"]]);
});

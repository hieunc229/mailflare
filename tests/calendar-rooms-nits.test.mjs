import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test, { after } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { installSqlite, loadFixture } from "./helpers/fixtures.mjs";

const { migrations } = JSON.parse(readFileSync(new URL("../src/lib/migrations/bundle.json", import.meta.url), "utf8"));
const schema = "PRAGMA foreign_keys = ON;\n" + migrations.flatMap((migration) => migration.statements).join(";\n");
const en = JSON.parse(readFileSync(new URL("../src/lib/i18n/en.json", import.meta.url), "utf8"));
globalThis.roomsNits = { en };
const langMock = { "@/components/language-provider": "export function useLanguage(){return {t:(key,values={})=>(globalThis.roomsNits.en[key]??key).replace(/\\{(\\w+)\\}/g,(m,n)=>values[n]??m)}}" };
const lib = await loadFixture({ name: "rooms-nits-lib", entryPoint: "src/lib/calendar/resources.ts", mocks: {} });
const dialog = await loadFixture({ name: "rooms-nits-dialog", entryPoint: "src/app/(admin)/rooms/room-dialog.tsx", mocks: langMock });
const view = await loadFixture({ name: "rooms-nits-view", entryPoint: "src/app/(admin)/rooms/rooms-view.tsx", mocks: langMock });
const { createResource, deleteResource } = await lib.import();
const { RoomFields } = await dialog.import();
const { RoomsView } = await view.import();
let sqlite;
after(() => { sqlite?.close(); delete globalThis.roomsNits; delete globalThis.nitsDb; for (const fixture of [lib, dialog, view]) fixture.dispose(); });

test("a delete refused for bookings reports at most 200 and says the count was capped", async () => {
	sqlite = installSqlite("nitsDb", { schema });
	const db = globalThis.nitsDb.db;
	db.batch = async (list) => { for (const statement of list) await statement; };
	sqlite.exec("INSERT INTO users (id, email, name, password_hash, role, created_at) VALUES ('u1', 'u1@one.test', 'U', 'x', 'user', 1)");
	const room = (await createResource(db, "u1", { name: "R" })).resource;
	const ahead = Math.floor(Date.now() / 1000) + 86_400;
	sqlite.exec(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 250) INSERT INTO calendar_events (id, user_id, title, starts_at, ends_at, created_at, updated_at) SELECT 'e' || i, 'u1', 't', ${ahead}, ${ahead + 60}, 1, 1 FROM n`);
	sqlite.exec(`INSERT INTO calendar_resource_bookings (id, resource_id, event_id, status, created_at) SELECT 'b' || id, '${room.id}', id, 'accepted', 1 FROM calendar_events`);
	const refused = await deleteResource(db, room.id, false);
	assert.deepEqual([refused.status, refused.code, refused.bookings, refused.capped], [409, "HAS_BOOKINGS", 200, true]);
	sqlite.exec("DELETE FROM calendar_resource_bookings WHERE rowid > 5");
	const small = await deleteResource(db, room.id, false);
	assert.deepEqual([small.bookings, small.capped ?? false], [5, false]);
});

test("the capacity field says what is wrong, in words, and is tied to the field", () => {
	const html = renderToStaticMarkup(createElement(RoomFields, { target: "new", saving: false, error: "", onSave: () => {}, onClose: () => {} }));
	assert.doesNotMatch(html, /Enter a whole number/, "nothing is said about an empty field");
	const room = { id: "r1", name: "Boardroom", kind: "room", capacity: null, location: "", description: "", disabled: false };
	const bad = renderToStaticMarkup(createElement(RoomFields, { target: { ...room, capacity: 0 }, saving: false, error: "", onSave: () => {}, onClose: () => {} }));
	assert.match(bad, /<p id="room-capacity-error"[^>]*>Enter a whole number from 1 to 100000, or leave it empty\.<\/p>/);
	assert.match(bad, /<input[^>]*id="room-capacity"[^>]*aria-invalid="true"[^>]*aria-describedby="room-capacity-error"|<input[^>]*aria-describedby="room-capacity-error"[^>]*id="room-capacity"/);
	assert.equal(en["rooms.capacityInvalid"], "Enter a whole number from 1 to 100000, or leave it empty.");
});

test("a room row wraps its buttons instead of overflowing on a narrow screen", () => {
	const rooms = [{ id: "r1", name: "A room with a rather long name that must not push the buttons out", kind: "room", capacity: 12, location: "Building with a long name, 2nd floor", description: "", disabled: true }];
	const html = renderToStaticMarkup(createElement(RoomsView, { state: "ready", rooms, available: true, notice: "", deleting: false, onAdd: () => {}, onEdit: () => {}, onDelete: () => {}, onRetry: () => {} }));
	assert.match(html, /<div class="[^"]*\bflex-wrap\b[^"]*sm:flex-nowrap[^"]*"/);
	assert.match(html, /<span class="[^"]*\bml-auto\b[^"]*">.*aria-label="Edit /s);
});

test("the delete confirmation shows 200+ when the count was capped", () => {
	const page = readFileSync(new URL("../src/app/(admin)/rooms/page.tsx", import.meta.url), "utf8");
	assert.match(page, /failure\.capped \? `\$\{failure\.bookings\}\+` : failure\.bookings/);
});

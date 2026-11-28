import assert from "node:assert/strict";
import test from "node:test";
import { loadApp } from "./helpers/real-db.mjs";

const { app, newDatabase } = await loadApp("public-drive-listing", `
	export { buildPublicDriveListing } from "./src/lib/drive/public-listing.ts";
	export { getPublicDriveItem } from "./src/lib/drive/access.ts";
`);

async function seed(t, { driveEnabled = 1 } = {}) {
	const fixture = await newDatabase(t, `
		INSERT INTO users (id, email, password_hash, name, role, is_primary_admin, created_at, drive_enabled) VALUES ('u', 'u@example.com', 'x', 'U', 'admin', 1, 1, ${driveEnabled});
		INSERT INTO drive_items (id, owner_id, parent_id, kind, name, size, content_type, link_token, trashed_at, upload_id, created_at, updated_at) VALUES
			('root', 'u', NULL, 'folder', 'Shared', 0, 'application/octet-stream', 'tok', NULL, NULL, 1700000000, 1700000000),
			('f1', 'u', 'root', 'file', 'a.txt', 3, 'text/plain', NULL, NULL, NULL, 1700000000, 1700000000),
			('sub', 'u', 'root', 'folder', 'Sub', 0, 'application/octet-stream', NULL, NULL, NULL, 1700000000, 1700000000),
			('deep', 'u', 'sub', 'file', 'b.txt', 1, 'text/plain', NULL, NULL, NULL, 1700000000, 1700000000),
			('gone', 'u', 'root', 'file', 'gone.txt', 1, 'text/plain', NULL, 1700000001, NULL, 1700000000, 1700000000),
			('up', 'u', 'root', 'file', 'up.bin', 1, 'text/plain', NULL, NULL, 'upload-1', 1700000000, 1700000000),
			('tr', 'u', NULL, 'folder', 'Trashed', 0, 'application/octet-stream', 'trashed-tok', 1700000001, NULL, 1700000000, 1700000000);
	`);
	return fixture;
}

const listing = async (db, token, itemId) => {
	const resolved = await app.getPublicDriveItem(db, token, itemId);
	return resolved && app.buildPublicDriveListing(db, resolved.root, resolved.item);
};

test("listing of the shared folder", async (t) => {
	const { db } = await seed(t);
	const result = await listing(db, "tok");
	assert.equal(result.item.id, "root");
	assert.deepEqual(result.items.map((i) => i.id).sort(), ["f1", "sub"]);
	assert.deepEqual(result.path, [{ id: "root", name: "Shared" }]);
});

test("listing of a nested item keeps the path from the share root", async (t) => {
	const { db } = await seed(t);
	const result = await listing(db, "tok", "deep");
	assert.deepEqual(result.path.map((p) => p.id), ["root", "sub", "deep"]);
});

test("a file share has no children", async (t) => {
	const { db } = await seed(t);
	assert.deepEqual((await listing(db, "tok", "f1")).items, []);
});

test("missing, trashed or disabled-owner tokens resolve to null", async (t) => {
	const { db } = await seed(t);
	assert.equal(await app.getPublicDriveItem(db, "nope"), null);
	assert.equal(await app.getPublicDriveItem(db, "trashed-tok"), null);
	const disabled = await seed(t, { driveEnabled: 0 });
	assert.equal(await app.getPublicDriveItem(disabled.db, "tok"), null);
});

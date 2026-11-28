import assert from "node:assert/strict";
import test from "node:test";
import { loadComponent } from "./helpers/dom-component.mjs";

const { flattenDriveFolders } = await loadComponent("src/app/(drive)/drive-utils.ts");

test("flattenDriveFolders orders, nests and disables like both old copies", () => {
	const folders = [
		{ id: "a", name: "Folder 2", parentId: null },
		{ id: "b", name: "B", parentId: "a" },
		{ id: "c", name: "Folder 10", parentId: null },
		{ id: "d", name: "Alpha", parentId: "missing" },
	];
	const rows = flattenDriveFolders(folders);
	assert.deepEqual(rows.map((row) => row.id), ["d", "a", "b", "c"]);
	assert.deepEqual(rows.map((row) => row.depth), [0, 0, 1, 0]);
	assert.ok(rows.every((row) => row.disabled === false));
	const moving = Object.fromEntries(flattenDriveFolders(folders, new Set(["a"])).map((row) => [row.id, row.disabled]));
	assert.deepEqual(moving, { d: false, a: true, b: true, c: false });
});

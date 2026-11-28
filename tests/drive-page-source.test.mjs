import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../src/app/(drive)/drive/page.tsx", import.meta.url), "utf8");

test("load does not dispatch the folders event", () => {
	const start = source.indexOf("const load = useCallback(");
	const end = source.indexOf("}, [view, folder, query, typesParam, requestKey]);");
	assert.ok(start > -1 && end > start);
	assert.ok(!source.slice(start, end).includes("DRIVE_FOLDERS_EVENT"));
});

test("refresh dispatches the folders event", () => {
	const line = source.split("\n").find((entry) => entry.includes("const refresh = useCallback("));
	assert.ok(line?.includes("DRIVE_FOLDERS_EVENT"));
});

test("row action buttons are named after the file", () => {
	assert.ok(source.includes('aria-label={`${t("drive.actions")}: ${item.name}`}'));
});

test("page keeps no upload state", () => {
	assert.ok(!source.includes("useState<DriveUploadEntry"));
});

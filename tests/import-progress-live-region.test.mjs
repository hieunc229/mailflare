import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const takeout = readFileSync("src/components/settings/takeout-import.tsx", "utf8");
const jobs = readFileSync("src/components/settings/import-jobs.tsx", "utf8");

test("import progress is not a live region", () => {
	for (const source of [takeout, jobs]) {
		assert.ok(!source.includes("aria-live"));
		assert.ok(source.includes('role="status"') && source.includes("sr-only"));
	}
	assert.ok(takeout.includes('role="progressbar"') && takeout.includes("aria-valuenow={percent}"));
});

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = readFileSync(join(root, "src/components/settings/spam-filter-settings.tsx"), "utf8");

test("spam settings do not show defaults as real values when the load fails", () => {
	assert.match(source, /<Skeleton/, "placeholders stand in for the controls until the settings have loaded");
	assert.match(source, /status === "failed"/, "a failed load has its own state");
	assert.match(source, /t\("webhooks\.retry"\)/, "a failed load offers Retry");
	assert.match(source, /t\("settings\.spam\.loading"\)|aria-busy/, "loading is announced");
});

test("a failed load shows the translated message, not the raw error", () => {
	assert.doesNotMatch(source.slice(0, source.indexOf("async function updateEnabled")), /nextError\.message/);
});

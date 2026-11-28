import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const page = readFileSync("src/app/(dashboard)/inbox/[messageId]/page.tsx", "utf8");

test("a failed message fetch shows a retry state, not 'not found'", () => {
	assert.ok(!page.includes('({ error: t("message.notFound") })'));
	assert.ok(page.includes("setLoadFailed(true)"));
	const missing = page.slice(page.indexOf("if (!message) {"));
	assert.ok(missing.includes("loadFailed") && missing.includes('t("message.loadFailed")') && missing.includes("setReloadKey"));
	assert.match(page, /\}, \[messageId, reloadKey\]\);/);
	assert.equal(JSON.parse(readFileSync("src/lib/i18n/en.json", "utf8"))["message.loadFailed"], "Could not load this message.");
});

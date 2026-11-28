import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const hook = readFileSync("src/hooks/use-messages.ts", "utf8");
const page = readFileSync("src/components/messages/message-folder-page.tsx", "utf8");

test("a failed message list load is reported instead of looking empty", () => {
	assert.match(hook, /catch \(error\) \{[^}]*setLoadError\(true\);[^}]*throw error;/);
	assert.ok(hook.indexOf("setLoadError(false)") > hook.indexOf('type: "loaded"'));
	assert.match(hook, /return \{[^}]*\bloadError\b[^}]*\};\s*\}\s*$/);
	assert.match(page, /\bloadError\b[^=]*\} = useMessages\(/);
	assert.ok(page.includes("!loadError"), "empty states wait for a successful load");
	assert.match(page, /onClick=\{[^}]*refreshMessageViews\(\)/);
});

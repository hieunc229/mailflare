import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const page = readFileSync(new URL("../src/app/(calendar)/calendar/page.tsx", import.meta.url), "utf8");
const dialog = readFileSync(new URL("../src/app/(calendar)/calendar/publish-dialog.tsx", import.meta.url), "utf8");

test("the calendar options menu opens the publish dialog", () => {
	assert.match(page, /import \{ PublishDialog \} from "\.\/publish-dialog"/);
	assert.match(page, /setPublishOpen\(true\)[^\n]*t\("calendar\.publish"\)/);
	assert.match(page, /<PublishDialog open=\{publishOpen\} onOpenChange=\{setPublishOpen\} \/>/);
});

test("the dialog scrolls inside the viewport (CLAUDE.md) and fits a 375 px screen", () => {
	assert.match(dialog, /max-h-\[calc\(100vh-4rem\)\][^"]*overflow-y-auto/);
	assert.match(dialog, /w-\[min\(\d+px,calc\(100vw-32px\)\)\]/);
});

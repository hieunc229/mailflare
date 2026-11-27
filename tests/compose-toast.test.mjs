import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const directory = mkdtempSync(join(tmpdir(), "mailflare-compose-toast-"));
after(() => rmSync(directory, { recursive: true, force: true }));
await build({ entryPoints: [join(root, "src/components/compose/send-notice-utils.ts")], outfile: join(directory, "u.mjs"), bundle: true, format: "esm", platform: "node", logLevel: "silent" });
const { composeToastDurationMs } = await import(pathToFileURL(join(directory, "u.mjs")).href);
const source = readFileSync(join(root, "src/components/compose/compose-form.tsx"), "utf8");

test("errors stay long enough to read and reach (WCAG 2.2.1), successes stay short", () => {
	assert.equal(composeToastDurationMs("error"), 15_000);
	assert.equal(composeToastDurationMs("success"), 3200);
});

test("the compose toast uses the duration helper, pauses on hover and focus, and can be dismissed", () => {
	assert.doesNotMatch(source, /setTimeout\(\(\) => setToast\(null\), 3200\)/);
	assert.match(source, /composeToastDurationMs\(toast\.type\)/);
	assert.match(source, /isToastPaused\(/);
	assert.match(source, /onPointerEnter/);
	assert.match(source, /onFocusCapture/);
	assert.match(source, /t\("promotions\.toast\.dismiss"\)/);
	assert.match(source, /key === "Escape"/);
});

test("each remove-attachment button names its file", () => {
	assert.equal(source.match(/sr-only">\{t\("compose\.removeAttachment"\)\}/g), null, "bare label is gone");
	assert.equal(source.match(/\$\{t\("compose\.removeAttachment"\)\} \$\{/g)?.length, 2);
});

test("a rejected file does not leave the picker unable to re-pick the same file", () => {
	const fn = source.slice(source.indexOf("function addAttachments"));
	const reset = fn.indexOf("attachmentInput.current.value");
	assert.ok(reset > -1 && reset < fn.indexOf("nextCount > 10"), "input is reset before validation returns");
	assert.ok(fn.indexOf("Array.from(files)") > -1 && fn.indexOf("Array.from(files)") < reset, "the live FileList is copied before the reset empties it");
});

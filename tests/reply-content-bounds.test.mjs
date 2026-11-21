import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(join(tmpdir(), "mailflare-reply-bounds-"));
after(() => rmSync(outDir, { recursive: true, force: true }));

await build({
	entryPoints: [join(root, "src/lib/email/parse.ts")],
	outfile: join(outDir, "parse.mjs"),
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node22",
	logLevel: "silent",
});
await build({
	entryPoints: [join(root, "src/lib/email/reply-content-utils.ts")],
	outfile: join(outDir, "reply.mjs"),
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node22",
	logLevel: "silent",
});

const { buildSnippet } = await import(pathToFileURL(join(outDir, "parse.mjs")).href);
const { getLatestEmailContent, splitRepliedEmailContent } = await import(pathToFileURL(join(outDir, "reply.mjs")).href);

test("deeply nested quote prefixes do not overflow the stack", () => {
	assert.doesNotThrow(() => getLatestEmailContent(">".repeat(100_000)));
	assert.doesNotThrow(() => buildSnippet(">".repeat(100_000), null));
});

test("repeated 'wrote:' markers do not overflow the stack", () => {
	assert.doesNotThrow(() => splitRepliedEmailContent("On a wrote:\n".repeat(20_000)));
	assert.doesNotThrow(() => buildSnippet("On a wrote:\n".repeat(20_000), null));
});

test("a very long whitespace run in an 'On ... wrote:' candidate line stays fast", () => {
	const started = Date.now();
	splitRepliedEmailContent(`On a${" ".repeat(80_000)}b`);
	assert.ok(Date.now() - started < 500, "linear time");
});

test("normal replies still split", () => {
	const parts = splitRepliedEmailContent("Thanks!\n\nOn Mon, Jan 1, 2024 at 9:00 AM Bob <bob@example.com> wrote:\n> Hello\n> > older");
	assert.equal(parts.latestContent, "Thanks!");
	assert.equal(parts.quotedContent[0].content, "Hello");
	assert.equal(parts.quotedContent[0].quotedContent[0].content, "older");
});

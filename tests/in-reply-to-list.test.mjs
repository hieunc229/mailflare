import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(join(tmpdir(), "mailflare-in-reply-to-"));
after(() => rmSync(outDir, { recursive: true, force: true }));

await build({
	entryPoints: [join(root, "src/lib/email/parse.ts")],
	outfile: join(outDir, "entry.mjs"),
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node22",
	logLevel: "silent",
	alias: { "@": join(root, "src") },
	banner: { js: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);" },
});
const { parseRawMime } = await import(pathToFileURL(join(outDir, "entry.mjs")).href);

const parse = (inReplyTo) => {
	const raw = `From: a@b.example\r\nTo: c@d.example\r\nSubject: x\r\n${inReplyTo === null ? "" : `In-Reply-To: ${inReplyTo}\r\n`}\r\nbody\r\n`;
	return parseRawMime(new TextEncoder().encode(raw).buffer);
};

test("a single In-Reply-To id is stored without brackets", async () => {
	assert.equal((await parse("<one@x.example>")).inReplyTo, "one@x.example");
	assert.equal((await parse(null)).inReplyTo, null);
});

test("an In-Reply-To naming several ids keeps the last (immediate parent)", async () => {
	assert.equal((await parse("<one@x.example> <two@x.example>")).inReplyTo, "two@x.example");
});

import assert from "node:assert/strict";
import { after, test } from "node:test";
import { execFileSync } from "node:child_process";
import { build } from "esbuild";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "mime-address-cpu-"));
after(() => rmSync(dir, { recursive: true, force: true }));
const root = process.cwd();
const entry = join(dir, "entry.ts");
writeFileSync(entry, `
import { MimeLimitError, parseRawMime } from ${JSON.stringify(join(root, "src/lib/email/parse"))};
const enc = new TextEncoder();
// postal-mime before 3.0.1 parsed an address header in time that grew faster than its length.
const from = "From: " + "a.".repeat(30000);
let nested = from + "\\r\\n\\r\\nbody\\r\\n";
for (let i = 0; i < 8; i++) nested = from + "\\r\\nContent-Type: message/rfc822\\r\\n\\r\\n" + nested;
const cases = {
	dotted: from + "\\r\\nSubject: x\\r\\n\\r\\nhi\\r\\n",
	nested9: nested,
	foldedTo: "To: " + Array.from({ length: 20000 }, () => "a").join(",\\r\\n ") + "\\r\\nSubject: x\\r\\n\\r\\nhi\\r\\n",
};
const out = {};
for (const [name, text] of Object.entries(cases)) {
	const start = performance.now();
	let result;
	try {
		await parseRawMime(enc.encode(text).buffer);
		result = "parsed";
	} catch (error) {
		result = error instanceof MimeLimitError ? "rejected" : "other: " + error;
	}
	out[name] = { result, ms: Math.round(performance.now() - start) };
}
console.log(JSON.stringify(out));
`);
const bundle = join(dir, "entry.mjs");
await build({ entryPoints: [entry], bundle: true, outfile: bundle, platform: "node", format: "esm", alias: { "@": join(root, "src") }, logLevel: "silent", banner: { js: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);" } });

test("a crafted address header cannot stall parsing", () => {
	const out = JSON.parse(execFileSync(process.execPath, [bundle], { encoding: "utf8", timeout: 120_000 }));
	for (const [name, { result, ms }] of Object.entries(out)) {
		assert.ok(result === "parsed" || result === "rejected", `${name}: ${result}`);
		assert.ok(ms < 200, `${name} took ${ms} ms`);
	}
});

test("a legitimate multipart mail with 900 small attachments parses", async () => {
	const manyEntry = join(dir, "many-parts.ts");
	writeFileSync(manyEntry, `
import { parseRawMime } from ${JSON.stringify(join(root, "src/lib/email/parse"))};
const enc = new TextEncoder();
const head = "From: a@b.example\\r\\nTo: c@d.example\\r\\nSubject: many\\r\\nMIME-Version: 1.0\\r\\nContent-Type: multipart/mixed; boundary=\\"b\\"\\r\\n\\r\\n";
let body = head;
for (let i = 0; i < 900; i++) {
	body += "--b\\r\\nContent-Type: image/png\\r\\nContent-Disposition: attachment; filename=\\"img" + i + ".png\\"\\r\\nContent-Transfer-Encoding: base64\\r\\n\\r\\niVBORw0KGgo=\\r\\n";
}
body += "--b--\\r\\n";
try {
	const parsed = await parseRawMime(enc.encode(body).buffer);
	console.log(JSON.stringify({ result: "parsed", count: parsed.attachments.length }));
} catch (error) {
	console.log(JSON.stringify({ result: "error", message: String(error && (error.message || error)) }));
}
`);
	const manyBundle = join(dir, "many-parts.mjs");
	await build({ entryPoints: [manyEntry], bundle: true, outfile: manyBundle, platform: "node", format: "esm", alias: { "@": join(root, "src") }, logLevel: "silent", banner: { js: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);" } });
	const out = JSON.parse(execFileSync(process.execPath, [manyBundle], { encoding: "utf8", timeout: 120_000 }));
	assert.equal(out.message, undefined, out.message);
	assert.equal(out.result, "parsed");
	assert.equal(out.count, 900);
});

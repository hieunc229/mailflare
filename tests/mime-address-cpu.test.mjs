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
const cases = {
	dotted: (n) => "From: " + "a.".repeat(n) + "\\r\\nSubject: x\\r\\n\\r\\nhi\\r\\n",
	nested9: (n) => {
		const from = "From: " + "a.".repeat(n);
		let nested = from + "\\r\\n\\r\\nbody\\r\\n";
		for (let i = 0; i < 8; i++) nested = from + "\\r\\nContent-Type: message/rfc822\\r\\n\\r\\n" + nested;
		return nested;
	},
	foldedTo: (n) => "To: " + Array.from({ length: n }, () => "a").join(",\\r\\n ") + "\\r\\nSubject: x\\r\\n\\r\\nhi\\r\\n",
};
const sizes = { dotted: 7500, nested9: 7500, foldedTo: 5000 };
const run = async (text) => {
	let best = Infinity;
	let result;
	for (let i = 0; i < 3; i++) {
		const start = performance.now();
		try {
			await parseRawMime(enc.encode(text).buffer);
			result = "parsed";
		} catch (error) {
			result = error instanceof MimeLimitError ? "rejected" : "other: " + error;
		}
		best = Math.min(best, performance.now() - start);
	}
	return { result, ms: best };
};
const out = {};
for (const [name, make] of Object.entries(cases)) {
	const small = await run(make(sizes[name]));
	const large = await run(make(4 * sizes[name]));
	out[name] = { result: large.result, small: small.ms, large: large.ms };
}
console.log(JSON.stringify(out));
`);
const bundle = join(dir, "entry.mjs");
await build({ entryPoints: [entry], bundle: true, outfile: bundle, platform: "node", format: "esm", alias: { "@": join(root, "src") }, logLevel: "silent", banner: { js: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);" } });

test("a crafted address header cannot stall parsing", () => {
	const out = JSON.parse(execFileSync(process.execPath, [bundle], { encoding: "utf8", timeout: 120_000 }));
	for (const [name, { result, small, large }] of Object.entries(out)) {
		assert.ok(result === "parsed" || result === "rejected", `${name}: ${result}`);
		assert.ok(large < 10_000, `${name} took ${large} ms`);
		assert.ok(large < 6 * Math.max(small, 1), `${name} grew ${(large / small).toFixed(1)}x for 4x input (${small.toFixed(1)} -> ${large.toFixed(1)} ms)`);
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

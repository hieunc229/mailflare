import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dir = mkdtempSync(join(tmpdir(), "mailflare-drive-import-"));
after(() => rmSync(dir, { recursive: true, force: true }));
await build({
	entryPoints: { u: join(root, "src/lib/drive/import-utils.ts") },
	outdir: dir, outExtension: { ".js": ".mjs" }, bundle: true, platform: "node", format: "esm", logLevel: "silent",
	alias: { "@": join(root, "src") },
});
const { collisionCandidates, collisionPattern, contentTypeForName, importName, planImportFile, takeoutDrivePath } = await import(pathToFileURL(join(dir, "u.mjs")).href);

const prefix = ["Takeout", "Drive"];
const path = (name) => takeoutDrivePath(name, prefix);

test("a Takeout path becomes folder segments under the Drive folder", () => {
	assert.deepEqual(path("Takeout/Drive/a/b/c.docx"), { segments: ["a", "b", "c.docx"], directory: false });
	assert.deepEqual(path("Takeout/Drive/a/b/"), { segments: ["a", "b"], directory: true });
	assert.deepEqual(path("Takeout/Drive/./a//b.txt"), { segments: ["a", "b.txt"], directory: false });
	assert.deepEqual(path("Takeout/Drive/a\\b.txt"), { segments: ["a", "b.txt"], directory: false });
	assert.deepEqual(path("Takeout/Drive/  a   b  /x.txt"), { segments: ["a b", "x.txt"], directory: false });
	assert.deepEqual(path("Takeout/Drive/"), { segments: [], directory: true });
});

test("hostile entry names are rejected", () => {
	for (const name of [
		"Takeout/Drive/../evil.txt", "Takeout/Drive/a/../../evil.txt", "../Takeout/Drive/x", "Takeout/Drive/a/..\\..\\x",
		"/etc/passwd", "\\\\server\\share\\x", "C:/Windows/x.txt", "c:x.txt",
				`Takeout/Drive/${"x".repeat(256)}.txt`, "Takeout/Drive/ .. /x.txt", "Takeout/Other/x.txt",
		`Takeout/Drive/${Array.from({ length: 70 }, () => "d").join("/")}/x.txt`,
	]) {
		const result = path(name);
		assert.ok("error" in result, `${JSON.stringify(name)} should be rejected`);
	}
	assert.ok("error" in takeoutDrivePath("C:/x.txt", []));
});

test("collision candidates keep the last extension and fit in 255 characters", () => {
	const names = collisionCandidates("a.docx");
	assert.equal(names.length, 100);
	assert.deepEqual(names.slice(0, 3), ["a.docx", "a (1).docx", "a (2).docx"]);
	assert.equal(names[99], "a (99).docx");
	assert.equal(collisionCandidates("a.tar.gz")[1], "a.tar (1).gz");
	assert.equal(collisionCandidates(".env")[1], ".env (1)");
	assert.equal(collisionCandidates("noext")[1], "noext (1)");
	const long = `${"x".repeat(251)}.txt`;
	for (const name of collisionCandidates(long)) assert.ok(name.length <= 255, name.length);
	assert.ok(collisionCandidates(long)[1].endsWith(" (1).txt"));
});

const file = (over) => ({ kind: "file", size: 5, pending: false, fingerprint: null, trashed: false, ...over });
const request = { name: "a.txt", size: 5, fingerprint: "gt:00000001:5" };

test("planning: an identical finished file is skipped", () => {
	assert.deepEqual(planImportFile(new Map([["a.txt", [file()]]]), request), { action: "skip" });
});

test("planning: a free name is used, and a trashed file does not occupy it", () => {
	assert.deepEqual(planImportFile(new Map([["a.txt", []]]), request), { action: "upload", name: "a.txt" });
	assert.deepEqual(planImportFile(new Map([["a.txt", [file({ trashed: true })]]]), request), { action: "upload", name: "a.txt" });
});

test("planning: a pending upload with the same size and fingerprint resumes", () => {
	assert.deepEqual(planImportFile(new Map([["a.txt", [file({ pending: true, fingerprint: "gt:00000001:5" })]]]), request), { action: "upload", name: "a.txt" });
});

test("planning: another file with the same name moves on to the next name", () => {
	const other = new Map([["a.txt", [file({ size: 9 })]], ["a (1).txt", []]]);
	assert.deepEqual(planImportFile(other, request), { action: "upload", name: "a (1).txt" });
	const pendingOther = new Map([["a.txt", [file({ pending: true, fingerprint: "gt:ffffffff:5" })]], ["a (1).txt", []]]);
	assert.deepEqual(planImportFile(pendingOther, request), { action: "upload", name: "a (1).txt" });
	const folder = new Map([["a.txt", [{ kind: "folder", size: 0, pending: false, fingerprint: null, trashed: false }]], ["a (1).txt", []]]);
	assert.deepEqual(planImportFile(folder, request), { action: "upload", name: "a (1).txt" });
	const afterSuffix = new Map([["a.txt", [file({ size: 9 })]], ["a (1).txt", [file()]]]);
	assert.deepEqual(planImportFile(afterSuffix, request), { action: "skip" });
});

test("planning: asks for a name it has not been given, and gives up after 100 names", () => {
	assert.deepEqual(planImportFile(new Map([["a.txt", [file({ size: 9 })]]]), request), { action: "unknown", name: "a (1).txt" });
	assert.deepEqual(planImportFile(new Map(), request), { action: "unknown", name: "a.txt" });
	const full = new Map(collisionCandidates("a.txt").map((name) => [name, [file({ size: 9 })]]));
	assert.equal(planImportFile(full, request).action, "error");
});

test("content types come from a fixed list and are checked against the first bytes", () => {
	const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
	assert.equal(contentTypeForName("a.PNG"), "image/png");
	assert.equal(contentTypeForName("a.png", png), "image/png");
	assert.equal(contentTypeForName("a.png", new TextEncoder().encode("<svg onload=alert(1)>")), "application/octet-stream");
	assert.equal(contentTypeForName("a.pdf", new TextEncoder().encode("%PDF-1.7")), "application/pdf");
	assert.equal(contentTypeForName("a.pdf", new TextEncoder().encode("<html>")), "application/octet-stream");
	assert.equal(contentTypeForName("a.docx", Uint8Array.from([0x50, 0x4b, 3, 4])), "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
	assert.equal(contentTypeForName("a.docx", new TextEncoder().encode("hello")), "application/octet-stream");
	assert.equal(contentTypeForName("a.txt", new TextEncoder().encode("hello")), "text/plain");
	assert.equal(contentTypeForName("a.txt", new TextEncoder().encode("  <script>alert(1)</script>")), "application/octet-stream");
	assert.equal(contentTypeForName("a.csv", new TextEncoder().encode("a,b\n1,2")), "text/csv");
	for (const name of ["a.html", "a.htm", "a.svg", "a.xml", "a.js", "a.xhtml", "a.exe", "noext", ".env", "a.unknown"]) assert.equal(contentTypeForName(name), "application/octet-stream", name);
});

test("one pattern matches every collision candidate after the first", () => {
	// Pattern characters: % any run, _ any one character, ! escapes.
	const matches = (pattern, name) => new RegExp(`^${pattern.replace(/!(.)|%|_|[.*+?^${}()|[\]\\]/g, (m, escaped) => (escaped ? escaped.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") : m === "%" ? ".*" : m === "_" ? "." : `\\${m}`))}$`, "s").test(name);
	for (const name of ["a.docx", "report", ".env", "50%_off!.txt", "a.b.c", `${"x".repeat(251)}.txt`, `${"y".repeat(255)}`]) {
		const pattern = collisionPattern(name);
		for (const candidate of collisionCandidates(name).slice(1)) assert.ok(matches(pattern, candidate), `${pattern} should match ${candidate.slice(-20)}`);
	}
	assert.equal(collisionPattern("50%_off!.txt"), "50!%!_off!! (%).txt");
	assert.equal(matches(collisionPattern("a.docx"), "a.docx"), false);
});

test("invisible characters are stripped from names and the rest is NFC", () => {
	const invisible = ["\u0000", "\u0001", "\u007f", "\u0085", "\u009f", "\u200b", "\u200c", "\u200d", "\u202a", "\u202e", "\u2066", "\u2069", "\ufeff"];
	for (const char of invisible) {
		assert.deepEqual(path(`Takeout/Drive/in${char}voice.pdf`), { segments: ["invoice.pdf"], directory: false }, JSON.stringify(char));
		assert.equal(importName(`in${char}voice.pdf`), "invoice.pdf");
	}
	// A right-to-left override cannot turn "gpj.exe" into a picture-looking name.
	assert.deepEqual(path("Takeout/Drive/photo\u202Egpj.exe"), { segments: ["photogpj.exe"], directory: false });
	assert.deepEqual(path("Takeout/Drive/cafe\u0301.txt"), { segments: ["caf\u00e9.txt"], directory: false });
	assert.equal(importName("cafe\u0301"), "caf\u00e9");
	assert.equal(importName("\u200b"), null);
	assert.equal(importName("  a  "), "a");
	// Stripping happens before the path checks: these are not hidden from them.
	for (const name of ["Takeout/Drive/.\u200b./x", "Takeout/Drive/a/.\u202e./x", "\u200b/etc/passwd", "C\u200b:/x", "Takeout/Drive/a\u0000/..\u0000/x"]) assert.ok("error" in path(name), JSON.stringify(name));
});

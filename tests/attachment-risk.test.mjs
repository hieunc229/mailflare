import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dir = mkdtempSync(join(tmpdir(), "mailflare-attachment-risk-"));
after(() => rmSync(dir, { recursive: true, force: true }));
await build({ entryPoints: [join(root, "src/lib/email/attachment-risk.ts")], outfile: join(dir, "r.mjs"), bundle: true, platform: "node", format: "esm", logLevel: "silent" });
const risk = await import(pathToFileURL(join(dir, "r.mjs")).href);

/** A minimal ZIP: only the central directory and end record matter to the inspector. */
function zip(names, { encrypted = false } = {}) {
	const parts = [];
	for (const name of names) {
		const nameBytes = Buffer.from(name);
		const entry = Buffer.alloc(46 + nameBytes.length);
		entry.writeUInt32LE(0x02014b50, 0);
		entry.writeUInt16LE(encrypted ? 1 : 0, 8);
		entry.writeUInt16LE(nameBytes.length, 28);
		nameBytes.copy(entry, 46);
		parts.push(entry);
	}
	const directory = Buffer.concat(parts);
	const end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50, 0);
	end.writeUInt16LE(names.length, 10);
	end.writeUInt32LE(directory.length, 12);
	end.writeUInt32LE(0, 16);
	return { tail: new Uint8Array(Buffer.concat([directory, end])), directory: new Uint8Array(directory) };
}

test("dangerous types and disguised names are blocked, plain documents are fine", () => {
	for (const filename of ["setup.exe", "run.JS", "invoice.pdf.exe", "report.docm", "photo.jpg.scr", "evil‮gpj.exe", "shortcut.lnk"]) {
		assert.equal(risk.assessAttachmentRisk({ filename }).level, "blocked", filename);
	}
	for (const filename of ["login.html", "files.zip", "disk.iso", "logo.svg", "invoice.pdf.html"]) {
		assert.notEqual(risk.assessAttachmentRisk({ filename }).level, "ok", filename);
	}
	for (const filename of ["invoice.pdf", "notes.txt", "photo.jpeg", "budget.xlsx", "archive.2024.final.docx"]) {
		assert.equal(risk.assessAttachmentRisk({ filename, type: "application/octet-stream" }).level, "ok", filename);
	}
	assert.equal(risk.assessAttachmentRisk({ filename: "x.bin", type: "application/x-msdownload" }).level, "blocked");
});

test("a ZIP's contents are read from its central directory", () => {
	const { tail, directory } = zip(["docs/readme.txt", "setup.exe"]);
	const found = risk.inspectZipDirectory(tail, () => directory);
	assert.equal(found.level, "blocked");
	assert.match(found.reasons[0], /setup\.exe/);
	const clean = zip(["a.txt", "b.png"]);
	assert.equal(risk.inspectZipDirectory(clean.tail, () => clean.directory).level, "ok");
	const locked = zip(["a.txt"], { encrypted: true });
	assert.equal(risk.inspectZipDirectory(locked.tail, () => locked.directory).level, "warning");
	assert.equal(risk.inspectZipDirectory(tail, () => null).level, "warning", "unreadable directory is flagged, not trusted");
	assert.equal(risk.inspectZipDirectory(new Uint8Array(100), () => null).level, "ok", "not a zip");
});

test("merging keeps the strongest level and de-duplicates reasons", () => {
	const merged = risk.mergeRisks({ level: "warning", reasons: ["a"] }, { level: "blocked", reasons: ["b", "a"] }, { level: "ok", reasons: [] });
	assert.deepEqual(merged, { level: "blocked", reasons: ["a", "b"] });
});

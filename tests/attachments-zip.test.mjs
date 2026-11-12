import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { crc32 as nodeCrc32 } from "node:zlib";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dir = mkdtempSync(join(tmpdir(), "mailflare-zip-"));
after(() => rmSync(dir, { recursive: true, force: true }));
await build({
	stdin: {
		contents: `
			export { crc32, createZipStream, uniqueZipNames } from "./src/lib/zip";
			export { locateZipDirectory, inspectZipDirectory } from "./src/lib/email/attachment-risk";
		`,
		resolveDir: root,
		loader: "ts",
	},
	outfile: join(dir, "zip.mjs"),
	bundle: true,
	platform: "node",
	format: "esm",
	logLevel: "silent",
	alias: { "@": join(root, "src") },
});
const zip = await import(pathToFileURL(join(dir, "zip.mjs")).href);

function streamOf(...chunks) {
	return new ReadableStream({
		start(controller) {
			for (const chunk of chunks) controller.enqueue(chunk);
			controller.close();
		},
	});
}

async function collect(stream) {
	const parts = [];
	for await (const chunk of stream) parts.push(chunk);
	const out = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
	let at = 0;
	for (const part of parts) { out.set(part, at); at += part.byteLength; }
	return out;
}

/** Parses the central directory of a generated archive: names, local offsets, CRCs and sizes. */
function centralDirectory(bytes) {
	const located = zip.locateZipDirectory(bytes);
	assert.ok(located, "end of central directory found");
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const entries = [];
	let at = located.offset;
	while (at < located.offset + located.size) {
		assert.equal(view.getUint32(at, true), 0x02014b50, "central header signature");
		const nameLength = view.getUint16(at + 28, true);
		const extraLength = view.getUint16(at + 30, true);
		const commentLength = view.getUint16(at + 32, true);
		entries.push({
			name: new TextDecoder().decode(bytes.subarray(at + 46, at + 46 + nameLength)),
			crc: view.getUint32(at + 16, true),
			size: view.getUint32(at + 24, true),
			offset: view.getUint32(at + 42, true),
			flags: view.getUint16(at + 8, true),
		});
		at += 46 + nameLength + extraLength + commentLength;
	}
	assert.equal(at, located.offset + located.size, "central directory ends exactly");
	return entries;
}

/** Reads one entry back out of the archive via its local header and data descriptor. */
function entryData(bytes, entry) {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	assert.equal(view.getUint32(entry.offset, true), 0x04034b50, "local header signature");
	const nameLength = view.getUint16(entry.offset + 26, true);
	const extraLength = view.getUint16(entry.offset + 28, true);
	const start = entry.offset + 30 + nameLength + extraLength;
	const data = bytes.subarray(start, start + entry.size);
	// The data descriptor follows the data and repeats the CRC and sizes from the directory.
	assert.equal(view.getUint32(start + entry.size, true), 0x08074b50, "data descriptor signature");
	assert.equal(view.getUint32(start + entry.size + 4, true), entry.crc);
	assert.equal(view.getUint32(start + entry.size + 8, true), entry.size);
	assert.equal(view.getUint32(start + entry.size + 12, true), entry.size);
	return data;
}

test("crc32 matches zlib across chunked input", () => {
	const one = new TextEncoder().encode("hello ");
	const two = new TextEncoder().encode("world");
	assert.equal(zip.crc32(one), nodeCrc32(one));
	assert.equal(zip.crc32(two, zip.crc32(one)), nodeCrc32(Buffer.concat([one, two])));
	assert.equal(zip.crc32(new Uint8Array(0)), nodeCrc32(Buffer.alloc(0)));
});

test("uniqueZipNames cleans and deduplicates", () => {
	assert.deepEqual(zip.uniqueZipNames(["a.pdf", "a.pdf", "a.pdf", "b.txt", "\\x\\y.txt", ""]), [
		"a.pdf", "a (2).pdf", "a (3).pdf", "b.txt", "_x_y.txt", "file",
	]);
	assert.deepEqual(zip.uniqueZipNames(["no-extension", "no-extension"]), ["no-extension", "no-extension (2)"]);
});

test("createZipStream produces a parseable archive whose entries verify", async () => {
	const encoder = new TextEncoder();
	const bodies = {
		"hello.txt": encoder.encode("hello world"),
		"hello (2).txt": encoder.encode("hello again"),
		"résumé.pdf": new Uint8Array([0x25, 0x50, 0x44, 0x46, 1, 2, 3]),
		"empty.bin": new Uint8Array(0),
	};
	const stream = zip.createZipStream([
		{ name: "hello.txt", open: () => streamOf(bodies["hello.txt"]) },
		// Two chunks exercise the incremental CRC path.
		{ name: "hello.txt", open: () => streamOf(bodies["hello (2).txt"].subarray(0, 5), bodies["hello (2).txt"].subarray(5)) },
		{ name: "résumé.pdf", open: () => streamOf(bodies["résumé.pdf"]) },
		{ name: "empty.bin", open: () => streamOf(bodies["empty.bin"]) },
		// A missing object is skipped rather than aborting the archive.
		{ name: "gone.txt", open: () => null },
	]);
	const bytes = await collect(stream);

	const entries = centralDirectory(bytes);
	assert.deepEqual(entries.map((entry) => entry.name), ["hello.txt", "hello (2).txt", "résumé.pdf", "empty.bin"]);
	for (const entry of entries) {
		const data = entryData(bytes, entry);
		assert.equal(nodeCrc32(Buffer.from(data)), entry.crc, `${entry.name} CRC`);
		assert.equal(data.byteLength, entry.size, `${entry.name} size`);
		assert.equal(entry.flags & 0x0808, 0x0808, `${entry.name} descriptor + UTF-8 flags`);
	}
	for (const [name, body] of Object.entries(bodies)) {
		const entry = entries.find((item) => item.name === name);
		assert.deepEqual(entryData(bytes, entry), body, name);
	}
	// The built-in risk inspector can read the directory we wrote.
	const risk = zip.inspectZipDirectory(bytes.slice(-65_557), (offset, size) => bytes.subarray(offset, offset + size));
	assert.equal(risk.level, "ok");
});

test("createZipStream on an empty list still emits a valid empty archive", async () => {
	const bytes = await collect(zip.createZipStream([]));
	assert.equal(bytes.byteLength, 22);
	assert.deepEqual(centralDirectory(bytes), []);
});

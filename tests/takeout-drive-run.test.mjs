import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { crc32 as nodeCrc32, deflateRawSync } from "node:zlib";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dir = mkdtempSync(join(tmpdir(), "mailflare-takeout-drive-"));
after(() => rmSync(dir, { recursive: true, force: true }));
await build({
	entryPoints: { run: join(root, "src/lib/import/takeout-drive-utils.ts"), scan: join(root, "src/lib/import/takeout-data-utils.ts") },
	outdir: dir, outExtension: { ".js": ".mjs" }, bundle: true, platform: "node", format: "esm", logLevel: "silent", splitting: false,
	alias: { "@": join(root, "src") },
});
const { importDriveFiles } = await import(pathToFileURL(join(dir, "run.mjs")).href);
const { scanTakeoutData } = await import(pathToFileURL(join(dir, "scan.mjs")).href);

function buildZip(entries) {
	const locals = [];
	const centrals = [];
	let offset = 0;
	for (const { name, data, method = 8, crc = nodeCrc32(data) } of entries) {
		const nameBytes = Buffer.from(name);
		const payload = method === 8 ? deflateRawSync(data) : data;
		const local = Buffer.alloc(30);
		local.writeUInt32LE(0x04034b50, 0);
		local.writeUInt16LE(method, 8);
		local.writeUInt32LE(crc, 14);
		local.writeUInt32LE(payload.length, 18);
		local.writeUInt32LE(data.length, 22);
		local.writeUInt16LE(nameBytes.length, 26);
		locals.push(local, nameBytes, payload);
		const central = Buffer.alloc(46);
		central.writeUInt32LE(0x02014b50, 0);
		central.writeUInt16LE(method, 10);
		central.writeUInt32LE(crc, 16);
		central.writeUInt32LE(payload.length, 20);
		central.writeUInt32LE(data.length, 24);
		central.writeUInt16LE(nameBytes.length, 28);
		central.writeUInt32LE(offset, 42);
		centrals.push(central, nameBytes);
		offset += 30 + nameBytes.length + payload.length;
	}
	const directory = Buffer.concat(centrals);
	const end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50, 0);
	end.writeUInt16LE(entries.length, 8);
	end.writeUInt16LE(entries.length, 10);
	end.writeUInt32LE(directory.length, 12);
	end.writeUInt32LE(offset, 16);
	return new Blob([...locals, directory, end]);
}

async function scanned(entries) {
	const scan = await scanTakeoutData([new File([buildZip(entries)], "t.zip")]);
	return scan.drive;
}
const entry = (name, text = "hello", extra = {}) => ({ name: `Takeout/Drive/${name}`, data: Buffer.from(text), ...extra });

/** A fake server that plans every file as an upload unless its name is in `skip` or `fail`, and a fake uploader that reads every part. */
function fakes(over = {}) {
	const state = { posts: [], uploads: [], ids: new Map(), next: 0 };
	const idFor = (parent, name) => { const key = `${parent}/${name}`; if (!state.ids.has(key)) state.ids.set(key, `f${state.next++}`); return state.ids.get(key); };
	const post = over.post ?? (async (path, body) => {
		state.posts.push({ path, body });
		if (path.endsWith("/folders")) {
			const folders = {};
			const errors = {};
			for (const p of body.paths) {
				if (over.tooDeep?.(p)) { errors[p.join("/")] = "Folders are nested too deeply"; continue; }
				if (over.badFolder?.(p)) { errors[p.join("/")] = "Folder name is not valid"; continue; }
				let parent = body.parentId;
				for (const segment of p) parent = idFor(parent, segment);
				folders[p.join("/")] = parent;
			}
			return { status: 200, data: { folders, errors } };
		}
		return { status: 200, data: { results: body.files.map((file) => over.plan?.(file) ?? { action: "upload", name: file.name }) } };
	});
	const upload = over.upload ?? (async (source, parentId, onProgress, signal) => {
		if (signal?.aborted) throw new Error("Upload cancelled");
		const chunks = [];
		for (let index = 0; index * 4 < source.size; index += 1) chunks.push(Buffer.from(await (await source.readPart(index, 4)).arrayBuffer()));
		await source.verify();
		onProgress(99, false);
		state.uploads.push({ name: source.name, parentId, type: source.type, fingerprint: source.fingerprint, text: Buffer.concat(chunks).toString() });
	});
	return { state, deps: { post, upload, sleep: async () => {}, ...over.deps } };
}
const settings = (over = {}) => ({ parentId: null, newFolderName: null, ...over });

test("files go into the folders of their paths under a new folder, with their bytes and fingerprint", async () => {
	const drive = await scanned([entry("a/b/one.txt", "hello world"), entry("two.pdf", "%PDF-1", { method: 0 }), entry("empty/", "", { method: 0 })]);
	const { state, deps } = fakes();
	const summary = await importDriveFiles(drive.files, drive.dirs, settings({ newFolderName: "Google Drive (2026-11-21)" }), deps);
	assert.deepEqual(state.posts[0], { path: "/api/drive/import/folders", body: { parentId: null, paths: [["Google Drive (2026-11-21)"]] } });
	const target = state.ids.get("null/Google Drive (2026-11-21)");
	assert.ok(state.posts.some((post) => post.path.endsWith("/folders") && post.body.parentId === target && JSON.stringify(post.body.paths) === JSON.stringify([["empty"]])));
	const one = state.uploads.find((upload) => upload.name === "one.txt");
	assert.equal(one.text, "hello world");
	assert.equal(one.parentId, state.ids.get(`${state.ids.get(`${target}/a`)}/b`));
	assert.equal(one.fingerprint, `gt:${nodeCrc32(Buffer.from("hello world")).toString(16).padStart(8, "0")}:11`);
	assert.equal(one.type, "text/plain");
	assert.equal(state.uploads.find((upload) => upload.name === "two.pdf").parentId, target);
	assert.deepEqual([summary.imported, summary.skipped, summary.failed, summary.aborted, summary.storageFull, summary.stoppedAfterFailures], [2, 0, 0, false, false, false]);
});

test("files go to the top of My Drive when no folder is chosen, and into an existing folder when one is", async () => {
	const drive = await scanned([entry("one.txt")]);
	const a = fakes();
	await importDriveFiles(drive.files, drive.dirs, settings(), a.deps);
	assert.equal(a.state.posts.some((post) => post.path.endsWith("/folders")), false);
	assert.equal(a.state.posts[0].body.files[0].folderId, null);
	assert.equal(a.state.uploads[0].parentId, null);
	const b = fakes();
	await importDriveFiles(drive.files, drive.dirs, settings({ parentId: "existing" }), b.deps);
	assert.equal(b.state.uploads[0].parentId, "existing");
});

test("files the server says are already there are skipped, not uploaded", async () => {
	const drive = await scanned([entry("one.txt"), entry("two.txt")]);
	const { state, deps } = fakes({ plan: (file) => (file.name === "one.txt" ? { action: "skip" } : undefined) });
	const summary = await importDriveFiles(drive.files, drive.dirs, settings(), deps);
	assert.deepEqual(state.uploads.map((upload) => upload.name), ["two.txt"]);
	assert.deepEqual([summary.imported, summary.skipped, summary.failed], [1, 1, 0]);
});

test("the server's name for a file is the one it is uploaded under", async () => {
	const drive = await scanned([entry("one.txt")]);
	const { state, deps } = fakes({ plan: () => ({ action: "upload", name: "one (1).txt" }) });
	await importDriveFiles(drive.files, drive.dirs, settings(), deps);
	assert.equal(state.uploads[0].name, "one (1).txt");
});

test("a file whose data does not match its CRC fails, the rest still import", async () => {
	const drive = await scanned([entry("bad.txt", "hello world", { crc: 1234 }), entry("good.txt", "fine")]);
	const { state, deps } = fakes();
	const summary = await importDriveFiles(drive.files, drive.dirs, settings(), deps);
	assert.deepEqual(state.uploads.map((upload) => upload.name), ["good.txt"]);
	assert.deepEqual([summary.imported, summary.failed], [1, 1]);
	assert.match(summary.errors[0], /bad\.txt.*corrupt/i);
});

test("a file that inflates past its declared size fails", async () => {
	const zip = buildZip([entry("bomb.txt", "x".repeat(100_000))]);
	// Make the directory claim 10 bytes: the size field of the central entry is at 24 after its signature.
	const bytes = Buffer.from(await zip.arrayBuffer());
	const central = bytes.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
	bytes.writeUInt32LE(10, central + 24);
	const scan = await scanTakeoutData([new File([bytes], "t.zip")]);
	const { state, deps } = fakes();
	const summary = await importDriveFiles(scan.drive.files, scan.drive.dirs, settings(), deps);
	assert.equal(state.uploads.length, 0);
	assert.equal(summary.failed, 1);
});

test("a full Drive (413) stops the import and says so", async () => {
	const drive = await scanned([entry("a.txt"), entry("b.txt"), entry("c.txt")]);
	let calls = 0;
	const { deps } = fakes({ upload: async () => { calls += 1; throw Object.assign(new Error("Not enough Drive storage left for this file"), { status: 413 }); } });
	const summary = await importDriveFiles(drive.files, drive.dirs, settings(), deps);
	assert.equal(calls, 1);
	assert.equal(summary.storageFull, true);
	assert.equal(summary.failed, 1);
});

test("another failure is counted and the import goes on", async () => {
	const drive = await scanned([entry("a.txt"), entry("b.txt")]);
	let calls = 0;
	const { deps } = fakes({ upload: async () => { calls += 1; if (calls === 1) throw new Error("Upload failed: network error"); } });
	const summary = await importDriveFiles(drive.files, drive.dirs, settings(), deps);
	assert.deepEqual([calls, summary.imported, summary.failed], [2, 1, 1]);
	assert.match(summary.errors[0], /network/);
});

test("Stop ends the run after the current file", async () => {
	const drive = await scanned([entry("a.txt"), entry("b.txt"), entry("c.txt")]);
	const controller = new AbortController();
	let calls = 0;
	const { deps } = fakes({ upload: async (source, parentId, onProgress, signal) => { calls += 1; controller.abort(); if (signal.aborted) throw new Error("Upload cancelled"); } });
	const summary = await importDriveFiles(drive.files, drive.dirs, settings(), { ...deps, signal: controller.signal });
	assert.equal(calls, 1);
	assert.equal(summary.aborted, true);
	assert.equal(summary.failed, 0);
});

test("a folder the server refuses fails the files inside it only", async () => {
	const drive = await scanned([entry("bad/one.txt"), entry("good/two.txt")]);
	const { state, deps } = fakes({ badFolder: (path) => path[0] === "bad" });
	const summary = await importDriveFiles(drive.files, drive.dirs, settings(), deps);
	assert.deepEqual(state.uploads.map((upload) => upload.name), ["two.txt"]);
	assert.deepEqual([summary.imported, summary.failed], [1, 1]);
	assert.match(summary.errors[0], /bad\/one\.txt/);
});

test("files in folders the server calls too deep are skipped and counted, the run goes on", async () => {
	const deep = Array.from({ length: 30 }, (_, i) => `d${i}`).join("/");
	const drive = await scanned([entry(`${deep}/deep.txt`), entry("ok/shallow.txt"), entry(`${deep}/empty/`, "", { method: 0 })]);
	const { state, deps } = fakes({ tooDeep: (path) => path.length > 24 });
	const summary = await importDriveFiles(drive.files, drive.dirs, settings(), deps);
	assert.deepEqual(state.uploads.map((upload) => upload.name), ["shallow.txt"]);
	assert.deepEqual([summary.imported, summary.skipped, summary.tooDeep, summary.failed], [1, 1, 1, 0]);
	assert.deepEqual(summary.errors, []);
});

test("requests are batched: at most 140 files and 25 folders each", async () => {
	const entries = Array.from({ length: 450 }, (_, index) => entry(`d${index % 60}/f${index}.txt`, "x"));
	const drive = await scanned(entries);
	const { state, deps } = fakes({ upload: async () => {} });
	const summary = await importDriveFiles(drive.files, drive.dirs, settings(), deps);
	const fileCalls = state.posts.filter((post) => post.path.endsWith("/files"));
	assert.ok(fileCalls.length >= 3);
	for (const call of fileCalls) {
		assert.ok(call.body.files.length <= 140);
		assert.ok(new Set(call.body.files.map((file) => file.folderId)).size <= 25);
	}
	for (const call of state.posts.filter((post) => post.path.endsWith("/folders"))) assert.ok(call.body.paths.length <= 100);
	assert.equal(summary.imported, 450);
});

test("folder requests hold at most 64 distinct folders, ancestors counted", async () => {
	const entries = [...Array.from({ length: 90 }, (_, index) => entry(`a${index % 9}/b${index}/c${index}/f.txt`, "x")), entry(`${Array.from({ length: 64 }, (_, i) => `deep${i}`).join("/")}/g.txt`, "x")];
	const drive = await scanned(entries);
	const { state, deps } = fakes({ upload: async () => {} });
	const summary = await importDriveFiles(drive.files, drive.dirs, settings(), deps);
	const calls = state.posts.filter((post) => post.path.endsWith("/folders"));
	assert.ok(calls.length >= 3);
	for (const call of calls) {
		const distinct = new Set(call.body.paths.flatMap((path) => path.map((_, i) => path.slice(0, i + 1).join("/"))));
		assert.ok(distinct.size <= 64, `${distinct.size} folders`);
	}
	assert.equal(summary.imported, 91);
});

test("a server error is retried, and a persistent one ends the run with an error", async () => {
	const drive = await scanned([entry("a.txt")]);
	let attempts = 0;
	const flaky = fakes({ post: async (path, body) => { attempts += 1; return attempts < 3 ? { status: 503, data: {} } : { status: 200, data: { results: body.files.map((file) => ({ action: "upload", name: file.name })) } }; } });
	const ok = await importDriveFiles(drive.files, drive.dirs, settings(), flaky.deps);
	assert.equal(ok.imported, 1);
	const down = fakes({ post: async () => ({ status: 503, data: {} }) });
	await assert.rejects(() => importDriveFiles(drive.files, drive.dirs, settings(), down.deps), /503/);
	const denied = fakes({ post: async () => ({ status: 404, data: { error: "Folder not found" } }) });
	await assert.rejects(() => importDriveFiles(drive.files, drive.dirs, settings({ parentId: "gone" }), denied.deps), /Folder not found/);
});

test("the content type comes from the extension and the first bytes, never from HTML or SVG", async () => {
	const drive = await scanned([entry("page.html", "<html>"), entry("pic.png", "<svg onload=alert(1)>"), entry("note.txt", "hi")]);
	const { state, deps } = fakes();
	await importDriveFiles(drive.files, drive.dirs, settings(), deps);
	const type = (name) => state.uploads.find((upload) => upload.name === name).type;
	assert.equal(type("page.html"), "application/octet-stream");
	assert.equal(type("pic.png"), "application/octet-stream");
	assert.equal(type("note.txt"), "text/plain");
});

test("progress counts files done out of the total", async () => {
	const drive = await scanned([entry("a.txt"), entry("b.txt")]);
	const seen = [];
	const { deps } = fakes();
	await importDriveFiles(drive.files, drive.dirs, settings(), { ...deps, onProgress: (progress) => seen.push(progress.done) });
	assert.equal(seen.at(-1), 2);
	assert.deepEqual(seen, [...seen].sort((a, b) => a - b));
});

const names = (count) => Array.from({ length: count }, (_, index) => entry(`f${String(index).padStart(2, "0")}.txt`));

test("five uploads failing in a row stop the run, the rest is left alone", async () => {
	const drive = await scanned(names(9));
	let calls = 0;
	const { state, deps } = fakes({ upload: async () => { calls += 1; throw new Error("Upload failed (500)"); } });
	const summary = await importDriveFiles(drive.files, drive.dirs, settings(), deps);
	assert.equal(calls, 5);
	assert.deepEqual([summary.failed, summary.imported, summary.stoppedAfterFailures, summary.aborted], [5, 0, true, false]);
	assert.equal(summary.total, 9);
	assert.equal(state.posts.filter((post) => post.path.endsWith("/files")).length, 1);
});

test("a success or a skip starts the count again, and files the server refuses do not count", async () => {
	const drive = await scanned(names(11));
	let calls = 0;
	const { deps } = fakes({
		plan: (file) => (file.name === "f04.txt" ? { action: "skip" } : undefined),
		upload: async () => { calls += 1; if (calls !== 5 && calls !== 10) throw new Error("Upload failed (500)"); },
	});
	const summary = await importDriveFiles(drive.files, drive.dirs, settings(), deps);
	// f00-f03 fail, f04 is skipped, f05 imports (the 5th upload), f06-f09 fail, f10 imports (the 10th): never five in a row.
	assert.deepEqual([summary.imported, summary.skipped, summary.failed, summary.stoppedAfterFailures], [2, 1, 8, false]);
	const refused = await scanned(names(8));
	const other = fakes({ plan: () => ({ action: "error", error: "File name, size or fingerprint is not valid" }) });
	const result = await importDriveFiles(refused.files, refused.dirs, settings(), other.deps);
	assert.deepEqual([result.failed, result.stoppedAfterFailures], [8, false]);
});

test("a busy server is asked up to five times, after its Retry-After or 2, 4, 8 and 16 seconds", async () => {
	const drive = await scanned([entry("a.txt")]);
	const waits = [];
	let answers = 0;
	const limited = fakes({ post: async (path, body) => ++answers === 1 ? { status: 429, data: {}, retryAfterMs: 7000 } : { status: 200, data: { results: body.files.map((file) => ({ action: "upload", name: file.name })) } }, deps: { sleep: async (ms) => { waits.push(ms); } } });
	assert.equal((await importDriveFiles(drive.files, drive.dirs, settings(), limited.deps)).imported, 1);
	assert.deepEqual(waits, [7000]);
	waits.length = 0;
	answers = 0;
	const down = fakes({ post: async () => { answers += 1; return { status: 503, data: {} }; }, deps: { sleep: async (ms) => { waits.push(ms); } } });
	await assert.rejects(() => importDriveFiles(drive.files, drive.dirs, settings(), down.deps), /503/);
	assert.equal(answers, 5);
	assert.deepEqual(waits, [2000, 4000, 8000, 16000]);
});

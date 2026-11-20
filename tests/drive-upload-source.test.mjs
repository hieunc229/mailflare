import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { after, beforeEach } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dir = mkdtempSync(join(tmpdir(), "mailflare-drive-upload-"));
after(() => rmSync(dir, { recursive: true, force: true }));

// The upload code talks to the server through authFetch and XMLHttpRequest; both are replaced by fakes.
const stubAuthClient = {
	name: "stub-auth-client",
	setup(b) {
		b.onResolve({ filter: /^@\/lib\/auth\/client$/ }, () => ({ path: "stub", namespace: "stub" }));
		b.onLoad({ filter: /.*/, namespace: "stub" }, () => ({
			contents: "export const authFetch = (...args) => globalThis.__authFetch(...args); export const getAuthHeaders = (h) => new Headers(h);",
			loader: "js",
		}));
	},
};
await build({
	entryPoints: { u: join(root, "src/app/(drive)/drive-upload.ts") },
	outdir: dir, outExtension: { ".js": ".mjs" }, bundle: true, platform: "node", format: "esm", logLevel: "silent",
	alias: { "@": join(root, "src") }, plugins: [stubAuthClient],
});
const { uploadDriveFile, uploadDriveSource, DriveUploadError } = await import(pathToFileURL(join(dir, "u.mjs")).href);

let calls;
let handler;
let parts;
/** What the next PUTs answer, oldest first: a status, [status, headers], or "network"; 200 when empty. */
let putResults;
beforeEach(() => {
	calls = [];
	parts = [];
	putResults = [];
	handler = () => new Response("{}", { status: 200 });
	globalThis.__authFetch = async (url, init = {}) => {
		calls.push({ url, method: init.method, body: init.body ? JSON.parse(init.body) : undefined });
		return handler(url, init);
	};
	globalThis.XMLHttpRequest = class {
		upload = {};
		status = 200;
		responseText = "{}";
		open(method, url) { this.url = url; }
		setRequestHeader() {}
		abort() { this.onabort?.(); }
		getResponseHeader(name) { return this.headers?.[name] ?? null; }
		send(chunk) {
			parts.push({ url: this.url, size: chunk.size });
			const next = putResults.shift();
			if (next === "network") { queueMicrotask(() => this.onerror()); return; }
			[this.status, this.headers] = Array.isArray(next) ? next : [next ?? 200, {}];
			if (this.status !== 200) this.responseText = JSON.stringify({ error: `Upload failed (${this.status})` });
			queueMicrotask(() => this.onload());
		}
	};
});

const json = (data, status = 200) => new Response(JSON.stringify(data), { status });
const source = (over = {}) => {
	const read = [];
	return { name: "a.bin", size: 10, type: "application/octet-stream", fingerprint: "gt:00000000:10", readPart: async (index, size) => { read.push(index); return new Blob([new Uint8Array(Math.min(size, 10 - index * size))]); }, read, ...over };
};

test("a source is uploaded part by part, then completed", async () => {
	handler = (url, init) => (init.method === "POST" && url === "/api/drive/upload" ? json({ id: "drv_1", partSize: 4, parts: 3, uploaded: [] }) : json({ item: {} }));
	const s = source();
	const progress = [];
	await uploadDriveSource(s, "folder1", (percent) => progress.push(percent));
	assert.deepEqual(calls[0].body, { name: "a.bin", size: 10, contentType: "application/octet-stream", parentId: "folder1", fingerprint: "gt:00000000:10" });
	assert.deepEqual(s.read, [0, 1, 2]);
	assert.deepEqual(parts.map((part) => part.url), ["/api/drive/upload/drv_1?part=1", "/api/drive/upload/drv_1?part=2", "/api/drive/upload/drv_1?part=3"]);
	assert.equal(calls.at(-1).url, "/api/drive/upload/drv_1");
	assert.equal(calls.at(-1).method, "POST");
	assert.ok(progress.every((percent) => percent <= 99));
});

test("parts the server already has are not read or sent again", async () => {
	handler = (url, init) => (init.method === "POST" && url === "/api/drive/upload" ? json({ id: "drv_1", partSize: 4, parts: 3, uploaded: [1, 2], resumed: true }) : json({ item: {} }));
	const s = source();
	await uploadDriveSource(s, null, () => {});
	assert.deepEqual(s.read, [2]);
	assert.equal(parts.length, 1);
});

test("an already complete upload (empty file) stops after the first call", async () => {
	handler = () => json({ item: {}, complete: true });
	await uploadDriveSource(source({ size: 0 }), null, () => {});
	assert.equal(calls.length, 1);
});

test("a failed start carries the HTTP status", async () => {
	handler = () => json({ error: "Not enough Drive storage left for this file" }, 413);
	await assert.rejects(() => uploadDriveSource(source(), null, () => {}), (error) => error instanceof DriveUploadError && error.status === 413 && /storage/.test(error.message));
});

test("a source that fails verification is discarded on the server and never completed", async () => {
	handler = (url, init) => (init.method === "POST" && url === "/api/drive/upload" ? json({ id: "drv_1", partSize: 4, parts: 3, uploaded: [] }) : json({ ok: true }));
	const s = source({ verify: async () => { throw new Error("a.bin is corrupt"); } });
	await assert.rejects(() => uploadDriveSource(s, null, () => {}), /corrupt/);
	assert.deepEqual(calls.slice(1).map((call) => [call.method, call.url]), [["DELETE", "/api/drive/upload/drv_1"]]);
});

test("an aborted upload stops without discarding what was sent", async () => {
	handler = (url, init) => (init.method === "POST" && url === "/api/drive/upload" ? json({ id: "drv_1", partSize: 4, parts: 3, uploaded: [] }) : json({ item: {} }));
	const controller = new AbortController();
	controller.abort();
	await assert.rejects(() => uploadDriveSource(source(), null, () => {}, controller.signal), /cancelled/i);
	assert.equal(calls.some((call) => call.method === "DELETE"), false);
	assert.equal(parts.length, 0);
});

test("uploadDriveFile still uploads a File with its modified time as the fingerprint", async () => {
	handler = (url, init) => (init.method === "POST" && url === "/api/drive/upload" ? json({ id: "drv_1", partSize: 4, parts: 1, uploaded: [] }) : json({ item: {} }));
	const file = new File([new Uint8Array(3)], "pic.png", { type: "image/png", lastModified: 1234 });
	await uploadDriveFile(file, null, () => {});
	assert.deepEqual(calls[0].body, { name: "pic.png", size: 3, contentType: "image/png", parentId: null, fingerprint: "1234" });
	assert.equal(parts.length, 1);
});

const started = (url, init) => (init.method === "POST" && url === "/api/drive/upload" ? json({ id: "drv_1", partSize: 4, parts: 3, uploaded: [] }) : json({ item: {} }));
const naps = () => { const waited = []; return { waited, options: { sleep: async (ms) => { waited.push(ms); } } }; };

test("starting, sending a part and completing are retried after a 5xx or 429, with backoff", async () => {
	let starts = 0;
	let completes = 0;
	handler = (url, init) => {
		if (url === "/api/drive/upload") return ++starts < 3 ? json({ error: "busy" }, 503) : started(url, init);
		if (init.method === "POST") return ++completes < 2 ? json({ error: "busy" }, 502) : json({ item: {} });
		return json({});
	};
	putResults = [503, "network", 429];
	const { waited, options } = naps();
	await uploadDriveSource(source(), null, () => {}, undefined, options);
	assert.equal(starts, 3);
	assert.equal(completes, 2);
	assert.equal(parts.length, 3 + 3);
	assert.deepEqual(waited, [1000, 2000, 1000, 2000, 4000, 1000]);
});

test("Retry-After is honoured for a request and for a part", async () => {
	let starts = 0;
	handler = (url, init) => (url === "/api/drive/upload" && ++starts === 1 ? new Response("{}", { status: 429, headers: { "Retry-After": "7" } }) : started(url, init));
	putResults = [[503, { "Retry-After": "9" }]];
	const { waited, options } = naps();
	await uploadDriveSource(source(), null, () => {}, undefined, options);
	assert.deepEqual(waited, [7000, 9000]);
});

test("a request is tried five times, then its status is reported", async () => {
	handler = () => json({ error: "down" }, 503);
	const { waited, options } = naps();
	await assert.rejects(() => uploadDriveSource(source(), null, () => {}, undefined, options), (error) => error instanceof DriveUploadError && error.status === 503);
	assert.equal(calls.length, 5);
	assert.deepEqual(waited, [1000, 2000, 4000, 8000]);
	handler = started;
	putResults = [500, 500, 500, 500, 500];
	waited.length = 0;
	await assert.rejects(() => uploadDriveSource(source(), null, () => {}, undefined, options), (error) => error.status === 500);
	assert.equal(parts.length, 5);
});

test("an answer that will not change is not retried", async () => {
	for (const status of [400, 404, 413]) {
		calls.length = 0;
		handler = () => json({ error: "no" }, status);
		const { waited, options } = naps();
		await assert.rejects(() => uploadDriveSource(source(), null, () => {}, undefined, options), (error) => error.status === status);
		assert.equal(calls.length, 1);
		assert.deepEqual(waited, []);
	}
	handler = started;
	putResults = [413];
	await assert.rejects(() => uploadDriveSource(source(), null, () => {}, undefined, naps().options), (error) => error.status === 413);
	assert.equal(parts.length, 1);
});

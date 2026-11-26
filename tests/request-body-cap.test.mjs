import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(join(tmpdir(), "mailflare-request-cap-"));
after(() => rmSync(outDir, { recursive: true, force: true }));

await build({
	stdin: {
		contents: 'export * from "./src/lib/http/request"; export * from "./src/lib/http/errors";',
		resolveDir: root,
	},
	outfile: join(outDir, "entry.mjs"),
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node22",
	logLevel: "silent",
});

const { readFormDataBody, readJsonBody, readRawBody, RequestBodyTooLargeError } = await import(pathToFileURL(join(outDir, "entry.mjs")).href);

function streamOf(chunks, onPull) {
	let index = 0;
	return new ReadableStream({
		pull(controller) {
			onPull?.(index);
			if (index >= chunks.length) return controller.close();
			controller.enqueue(chunks[index++]);
		},
	});
}

function streamingRequest(stream, headers = {}) {
	return new Request("http://localhost/x", { method: "POST", body: stream, headers, duplex: "half" });
}

test("a chunked body is cut off once it passes the cap, without reading the rest", async () => {
	let pulls = 0;
	const chunk = new Uint8Array(1024);
	// An endless stream: only the cap stops it.
	const stream = new ReadableStream({
		pull(controller) {
			pulls += 1;
			controller.enqueue(chunk);
		},
	});
	await assert.rejects(readRawBody(streamingRequest(stream), 10 * 1024), RequestBodyTooLargeError);
	assert.ok(pulls < 100, `stopped early (${pulls} pulls)`);
});

test("a declared Content-Length over the cap is refused before the body is read", async () => {
	let touched = false;
	const request = { headers: new Headers({ "content-length": "1000000" }), get body() { touched = true; return null; } };
	await assert.rejects(readRawBody(request, 1000), RequestBodyTooLargeError);
	assert.equal(touched, false);
});

test("bodies within the cap are returned intact", async () => {
	const body = await readRawBody(new Request("http://localhost/x", { method: "POST", body: "hello" }), 100);
	assert.equal(new TextDecoder().decode(body), "hello");
	assert.equal((await readRawBody(new Request("http://localhost/x"), 100)).byteLength, 0);
});

test("readJsonBody and readFormDataBody enforce the cap on undeclared lengths", async () => {
	const big = () => streamingRequest(streamOf([new Uint8Array(600), new Uint8Array(600)]));
	await assert.rejects(readJsonBody(big(), 1000), RequestBodyTooLargeError);
	await assert.rejects(readFormDataBody(big(), 1000), RequestBodyTooLargeError);
	assert.deepEqual(await readJsonBody(new Request("http://localhost/x", { method: "POST", body: '{"a":1}' }), 1000), { a: 1 });
});

test("the public inbound routes read their bodies through the capped reader", async () => {
	const { readFileSync } = await import("node:fs");
	for (const file of ["src/app/api/inbound/route.ts", "src/app/api/inbound/resend/route.ts"]) {
		const source = readFileSync(join(root, file), "utf8");
		assert.match(source, /readRawBody\(request/, file);
		assert.doesNotMatch(source, /request\.(arrayBuffer|text|json)\(\)/, file);
	}
});

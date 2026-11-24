import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import test from "node:test";
import { DEFAULT_MAX_HTTP_HEADER_SIZE, resolveMaxHeaderSize } from "../server/runtime/http-options.ts";

async function statusFor(serverOptions, headerBytes) {
	const server = createServer(serverOptions, (_request, response) => response.end("ok"));
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	try {
		const { port } = server.address();
		const response = await fetch(`http://127.0.0.1:${port}/api/inbound`, {
			method: "POST",
			headers: { "X-Mailflare-Headers": "a".repeat(headerBytes) },
			body: "x",
		});
		return response.status;
	} finally {
		server.close();
	}
}

test("a relay header map past Node's 16 KiB default is accepted", async () => {
	// What a Gmail message with Cloudflare's ARC headers looks like to the server.
	assert.equal(await statusFor({}, 20 * 1024), 431, "Node's default rejects it");
	assert.equal(await statusFor({ maxHeaderSize: resolveMaxHeaderSize(undefined) }, 20 * 1024), 200);
	assert.equal(await statusFor({ maxHeaderSize: resolveMaxHeaderSize(undefined) }, 48 * 1024), 200);
});

test("MAX_HTTP_HEADER_SIZE overrides the default and ignores unusable values", () => {
	assert.equal(resolveMaxHeaderSize(undefined), DEFAULT_MAX_HTTP_HEADER_SIZE);
	assert.equal(resolveMaxHeaderSize("131072"), 131072);
	for (const value of ["", "abc", "1024", "-1", "65536.5"]) {
		assert.equal(resolveMaxHeaderSize(value), DEFAULT_MAX_HTTP_HEADER_SIZE, `value ${JSON.stringify(value)}`);
	}
});

test("the self-hosted server passes the header budget to createServer", () => {
	const source = readFileSync(new URL("../server/index.ts", import.meta.url), "utf8");
	assert.match(source, /createServer\(\{\s*maxHeaderSize:\s*resolveMaxHeaderSize\(process\.env\.MAX_HTTP_HEADER_SIZE\)\s*\}/);
});

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (file) => readFileSync(join(root, file), "utf8");

test("the Worker applies the mta-sts host guard first in fetch, before the realtime route and the app", () => {
	const source = read("worker.ts");
	const fetch = source.slice(source.indexOf("async fetch("), source.indexOf("async email("));
	const guard = fetch.indexOf("guardMtaStsHost(");
	assert.ok(guard > 0, "fetch calls guardMtaStsHost");
	assert.ok(guard < fetch.indexOf("withD1ReadSession("), "before any database session is opened");
	assert.ok(guard < fetch.indexOf("/api/realtime"));
	assert.ok(guard < fetch.indexOf("vinextHandler.fetch"));
	assert.match(fetch, /if \(blocked\) return blocked;/);
});

test("the Node server applies it before handing any request to Next and before the WebSocket upgrade", () => {
	const source = read("server/index.ts");
	const handler = source.indexOf("createServer((request, response)");
	const guard = source.indexOf("guardMtaStsHost(", handler);
	assert.ok(guard > handler, "the request handler calls guardMtaStsHost");
	assert.ok(guard < source.indexOf("void handle(request, response", handler));
	const upgrade = source.slice(source.indexOf('server.on("upgrade"'));
	assert.match(upgrade.slice(0, 400), /mta-sts|guardMtaStsHost|isMtaStsHost/i, "an upgrade on an mta-sts host is refused too");
});

test("the policy route is a GET that delegates to serveMtaStsPolicy and is never cached by Next", () => {
	const source = read("src/app/.well-known/mta-sts.txt/route.ts");
	assert.match(source, /export async function GET\(request: Request\)/);
	assert.match(source, /serveMtaStsPolicy\(getEnv\(\), request\)/);
	assert.match(source, /export const dynamic = "force-dynamic"/);
});

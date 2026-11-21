import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadApp } from "./helpers/real-db.mjs";

const { app } = await loadApp("node-realtime-origin", `export { isRealtimeOriginAllowed } from "./server/runtime/realtime-origin.ts";`);
const allowed = (headers, options = {}) => app.isRealtimeOriginAllowed(headers, { trustProxy: false, ...options });

test("same-origin handshakes are accepted", () => {
	assert.equal(allowed({ host: "mail.example.com", "sec-fetch-site": "same-origin" }), true);
	assert.equal(allowed({ host: "mail.example.com", origin: "http://mail.example.com" }), true);
	assert.equal(allowed({ host: "mail.example.com", origin: "https://mail.example.com" }, { trustProxy: true, appUrl: undefined }), false, "scheme differs without a trusted proxy header");
	assert.equal(allowed({ host: "127.0.0.1:3000", origin: "https://mail.example.com" }, { appUrl: "https://mail.example.com" }), true);
	assert.equal(allowed({ host: "mail.example.com", origin: "https://mail.example.com", "x-forwarded-proto": "https" }, { trustProxy: true }), true);
});

test("a sibling-subdomain page cannot open the socket with the user's cookie", () => {
	assert.equal(allowed({ host: "mail.example.com", origin: "https://evil.example.com", "sec-fetch-site": "same-site" }), false);
	assert.equal(allowed({ host: "mail.example.com", origin: "https://evil.example.com" }, { appUrl: "https://mail.example.com" }), false);
	assert.equal(allowed({ host: "mail.example.com", "sec-fetch-site": "cross-site" }), false);
});

test("a handshake with no origin information is refused, a bearer token is not needed", () => {
	assert.equal(allowed({ host: "mail.example.com" }), false);
	assert.equal(allowed({ host: "mail.example.com", authorization: "Bearer abc" }), true);
});

test("the Node server applies the check and answers failed session lookups", () => {
	const source = readFileSync(new URL("../server/index.ts", import.meta.url), "utf8");
	assert.match(source, /isRealtimeOriginAllowed\(request\.headers/);
	assert.match(source, /\.catch\(\(error\) => \{[^}]*socket\.destroy\(\)/s);
});

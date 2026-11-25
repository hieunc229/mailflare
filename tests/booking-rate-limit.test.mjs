import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dir = mkdtempSync(join(root, "tests", ".tmp-booking-rate-limit-"));
after(() => rmSync(dir, { recursive: true, force: true }));
await build({
	entryPoints: { r: join(root, "src/lib/auth/rate-limit.ts") },
	outdir: dir, outExtension: { ".js": ".mjs" }, bundle: true, platform: "node", format: "esm", logLevel: "silent",
	alias: { "@": join(root, "src") },
});
const { allowBookingAttempt } = await import(pathToFileURL(join(dir, "r.mjs")).href);
const request = new Request("https://mail.example/api/public/booking/e1", { method: "POST", headers: { "cf-connecting-ip": "203.0.113.9" } });
const quiet = (fn) => { const warn = console.warn; console.warn = () => {}; return fn().finally(() => { console.warn = warn; }); };

test("booking mail is sent only when the limiter allows it", async () => {
	assert.equal(await allowBookingAttempt({ LOGIN_RATE_LIMIT: { limit: async () => ({ success: true }) } }, request), true);
	assert.equal(await allowBookingAttempt({ LOGIN_RATE_LIMIT: { limit: async () => ({ success: false }) } }, request), false);
});

test("a limiter that errors or is not bound refuses instead of letting anyone send host-signed mail", async () => {
	assert.equal(await quiet(() => allowBookingAttempt({ LOGIN_RATE_LIMIT: { limit: async () => { throw new Error("down"); } } }, request)), false);
	assert.equal(await quiet(() => allowBookingAttempt({}, request)), false);
});

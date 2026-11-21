import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dir = mkdtempSync(join(tmpdir(), "mailflare-realtime-"));
after(() => rmSync(dir, { recursive: true, force: true }));
await build({
	entryPoints: [join(root, "server/runtime/realtime.ts")],
	outfile: join(dir, "r.mjs"),
	bundle: true,
	platform: "node",
	format: "esm",
	logLevel: "silent",
	alias: { "@": join(root, "src") },
	external: ["ws"],
});
const { RealtimeHubRegistry } = await import(pathToFileURL(join(dir, "r.mjs")).href);

test("a socket error event is handled, not thrown", () => {
	const hub = new RealtimeHubRegistry();
	const socket = Object.assign(new EventEmitter(), { terminate() { this.terminated = true; } });
	hub.attach("user-1", socket);
	assert.doesNotThrow(() => socket.emit("error", new Error("Invalid WebSocket frame")));
	assert.equal(socket.terminated, true);
});

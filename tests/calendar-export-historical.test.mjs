import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import test from "node:test";

// The VTIMEZONE generator runs in a child process with a timeout: a scanner that failed to advance
// (rounded transition instants kept the old offset) hung forever on sub-minute historical offsets.
const require = createRequire(new URL("../package.json", import.meta.url));
const { build } = require("esbuild");
const bundled = await build({
	entryPoints: ["src/lib/calendar/vtimezone.ts"],
	bundle: true,
	platform: "node",
	format: "esm",
	write: false,
});
const moduleUrl = `data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString("base64")}`;

test("historical sub-minute offsets export their VTIMEZONE without hanging", { timeout: 30_000 }, () => {
	const child = spawnSync(process.execPath, ["--input-type=module", "-e",
		`import { vtimezoneLines } from ${JSON.stringify(moduleUrl)}; console.log(vtimezoneLines("Asia/Colombo", Date.parse("1905-12-25T00:00:00Z"), Date.parse("1906-01-10T00:00:00Z")).join("\\n"));`],
		{ timeout: 20_000, encoding: "utf8" });
	assert.equal(child.error, undefined, child.error?.message);
	assert.equal(child.status, 0, child.stderr);
	const lines = child.stdout.trim().split("\n");
	assert.ok(lines.includes("BEGIN:VTIMEZONE"), child.stdout);
	// Colombo moved from +05:19:32 to +05:30 on 1905-12-31; offsets carry seconds, not a rounded minute.
	assert.ok(lines.includes("TZOFFSETFROM:+051932"), child.stdout);
	assert.ok(lines.includes("TZOFFSETTO:+0530"), child.stdout);
});

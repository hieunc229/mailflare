import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (file) => readFileSync(join(root, file), "utf8");

test("the Worker runs the deliverability job only on the 02:00 UTC cron", () => {
	const line = read("worker.ts").split("\n").find((entry) => entry.includes("runDeliverabilityDaily(env"));
	assert.ok(line, "worker.ts calls runDeliverabilityDaily");
	assert.match(line, /controller\.cron === "0 2 \* \* \*"/);
});

test("the Node scheduler runs it in the once-a-day block, after the hour and day guard", () => {
	const source = read("server/runtime/scheduler.ts");
	assert.ok(source.indexOf("runDeliverabilityDaily(env, now)") > source.indexOf("lastRunDay = day"));
});

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (file) => readFileSync(join(root, file), "utf8");

test("the deliverability job is a daily job, not a frequent one", () => {
	const source = read("src/lib/scheduled/jobs.ts");
	assert.ok(source.indexOf("runDeliverabilityDaily(env, now)") > source.indexOf("export function dailyJobs"));
});

test("the Worker runs the daily jobs only on the 02:00 UTC cron", () => {
	const line = read("worker.ts").split("\n").find((entry) => entry.includes("dailyJobs(env, now)"));
	assert.ok(line, "worker.ts calls dailyJobs");
	assert.match(line, /controller\.cron === "0 2 \* \* \*"/);
});

test("the Node scheduler runs them after the hour and day guard", () => {
	const source = read("server/runtime/scheduler.ts");
	assert.ok(source.indexOf("dailyJobs(env, now)") > source.indexOf("lastRunDay = day"));
});

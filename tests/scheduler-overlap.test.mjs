import assert from "node:assert/strict";
import test, { after } from "node:test";
import { loadFixture } from "./helpers/fixtures.mjs";

const fixture = await loadFixture({
	name: "scheduler-overlap",
	entryPoint: "server/runtime/scheduler.ts",
	mocks: {
		"@/lib/scheduled/jobs": `
			export const frequentJobs = () => [{ name: "Slow", run() {} }];
			export const dailyJobs = () => [];
			export function runScheduledJob() {
				globalThis.__started = (globalThis.__started ?? 0) + 1;
				return new Promise((resolve) => { globalThis.__finish = resolve; });
			}
		`,
	},
});
after(() => fixture.dispose());
const { startScheduler } = await fixture.import();

test("a job still running is not started again on the next tick", async (t) => {
	t.mock.timers.enable({ apis: ["setInterval", "Date"] });
	globalThis.__started = 0;
	const stop = startScheduler({});
	t.after(stop);
	for (let i = 0; i < 3; i++) t.mock.timers.tick(60_000);
	assert.equal(globalThis.__started, 1);
	globalThis.__finish(true);
	await new Promise((resolve) => queueMicrotask(resolve));
	t.mock.timers.tick(60_000);
	assert.equal(globalThis.__started, 2);
});

test("a skipped run is logged as a warning naming the job", async (t) => {
	t.mock.timers.enable({ apis: ["setInterval", "Date"] });
	globalThis.__finish?.(true);
	await new Promise((resolve) => queueMicrotask(resolve));
	const warnings = [];
	t.mock.method(console, "warn", (...args) => warnings.push(args.join(" ")));
	globalThis.__started = 0;
	const stop = startScheduler({});
	t.after(stop);
	for (let i = 0; i < 3; i++) t.mock.timers.tick(60_000);
	globalThis.__finish(true);
	await new Promise((resolve) => queueMicrotask(resolve));
	assert.equal(warnings.length, 2);
	assert.match(warnings[0], /Slow.*skipped.*still running/i);
});

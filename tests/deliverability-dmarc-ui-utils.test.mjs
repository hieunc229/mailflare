import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(join(root, "tests", ".tmp-dmarc-ui-"));
after(() => rmSync(outDir, { recursive: true, force: true }));
await build({ entryPoints: { utils: join(root, "src/app/(admin)/deliverability/dmarc-utils.ts") }, outdir: outDir, outExtension: { ".js": ".mjs" }, bundle: true, platform: "node", format: "esm", target: "node22", tsconfig: join(root, "tsconfig.json"), logLevel: "silent" });
const { percent, dayTotal, chartMax, reportStatusKey, errorKey, segmentPercents } = await import(pathToFileURL(join(outDir, "utils.mjs")).href);

test("percent rounds, and is 0 for an empty total", () => {
	assert.deepEqual([percent(1, 3), percent(2, 3), percent(0, 0), percent(5, 5), percent(0, 10)], [33, 67, 0, 100, 0]);
});

test("dayTotal and chartMax add the four results", () => {
	const series = [{ day: "a", pass: 1, failDelivered: 2, quarantined: 3, rejected: 4 }, { day: "b", pass: 20, failDelivered: 0, quarantined: 0, rejected: 0 }];
	assert.equal(dayTotal(series[0]), 10);
	assert.equal(chartMax(series), 20);
	assert.equal(chartMax([]), 0);
});

test("segmentPercents give each result its share of the bar and the bar its share of the tallest", () => {
	assert.deepEqual(segmentPercents({ day: "a", pass: 5, failDelivered: 5, quarantined: 0, rejected: 0 }, 20), { height: 50, pass: 50, failDelivered: 50, quarantined: 0, rejected: 0 });
	assert.deepEqual(segmentPercents({ day: "a", pass: 0, failDelivered: 0, quarantined: 0, rejected: 0 }, 20), { height: 0, pass: 0, failDelivered: 0, quarantined: 0, rejected: 0 });
	assert.equal(segmentPercents({ day: "a", pass: 1, failDelivered: 0, quarantined: 0, rejected: 0 }, 1000).height, 2, "a tiny bar stays visible");
});

test("a report stuck in processing for over an hour is shown as too large", () => {
	const now = Date.parse("2025-11-19T12:00:00Z");
	assert.equal(reportStatusKey("ok", "2025-11-19T11:59:00Z", now), "ok");
	assert.equal(reportStatusKey("processing", "2025-11-19T11:30:00Z", now), "processing");
	assert.equal(reportStatusKey("processing", "2025-11-19T10:30:00Z", now), "stuck");
	assert.equal(reportStatusKey("rejected", "2025-11-19T10:30:00Z", now), "rejected");
	assert.equal(reportStatusKey("failed", "2025-11-19T10:30:00Z", now), "failed");
	assert.equal(reportStatusKey("unverified", "2025-11-19T10:30:00Z", now), "unverified");
	assert.equal(reportStatusKey("over_budget", "2025-11-19T10:30:00Z", now), "over_budget");
	assert.equal(reportStatusKey("something-new", "2025-11-19T10:30:00Z", now), "failed");
});

test("known error codes map to a translation key, unknown ones do not", () => {
	assert.equal(errorKey("ADDRESS_TAKEN"), "dmarc.error.ADDRESS_TAKEN");
	assert.equal(errorKey("MIGRATION_REQUIRED"), "dmarc.error.MIGRATION_REQUIRED");
	assert.equal(errorKey("DMARC_CHANGED"), "dmarc.error.DMARC_CHANGED");
	assert.equal(errorKey("TLS_RPT_ON"), "dmarc.error.TLS_RPT_ON");
	assert.equal(errorKey("SOMETHING_ELSE"), null);
	assert.equal(errorKey(undefined), null);
});

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(join(root, "tests", ".tmp-alerts-"));
after(() => rmSync(outDir, { recursive: true, force: true }));
await build({ entryPoints: { utils: join(root, "src/lib/deliverability/daily-utils.ts") }, outdir: outDir, outExtension: { ".js": ".mjs" }, bundle: true, platform: "node", format: "esm", target: "node22", tsconfig: join(root, "tsconfig.json"), logLevel: "silent" });
const { evaluateAlerts, mergeReporterAlerts, ALERT_RULES } = await import(pathToFileURL(join(outDir, "utils.mjs")).href);

const DAY = 86_400_000;
const NOW = new Date("2025-11-19T02:00:00Z");
const src = (sourceIp, messages, passMessages) => ({ sourceIp, messages, passMessages });
const base = { yesterday: [], prior30: [], reportsEnabledAt: new Date(NOW.getTime() - 30 * DAY), lastReportAt: new Date(NOW.getTime() - DAY), lastNoReportsAlertAt: null, now: NOW };
const kinds = (input) => evaluateAlerts({ ...base, ...input }).map((alert) => alert.kind);

test("spoofing: 10 failing messages from a source that never passed in the prior 30 days", () => {
	assert.deepEqual(kinds({ yesterday: [src("198.51.100.1", 10, 0)] }), ["spoofing"]);
	assert.deepEqual(kinds({ yesterday: [src("198.51.100.1", 9, 0)] }), [], "below the 10 message threshold");
	assert.deepEqual(kinds({ yesterday: [src("198.51.100.1", 10, 0)], prior30: [src("198.51.100.1", 5, 1)] }), [], "it passed once in the prior 30 days");
	assert.deepEqual(kinds({ yesterday: [src("198.51.100.1", 30, 21)] }), [], "9 failures only");
	assert.deepEqual(kinds({ yesterday: [src("198.51.100.1", 12, 2)] }), ["spoofing"], "10 failures out of 12");
});

test("spoofing lists the five biggest offenders, biggest first", () => {
	const yesterday = Array.from({ length: 8 }, (_, index) => src(`198.51.100.${index}`, 10 + index, 0));
	const [alert] = evaluateAlerts({ ...base, yesterday });
	assert.equal(alert.kind, "spoofing");
	assert.deepEqual(alert.detail.sources.map((entry) => entry.sourceIp), ["198.51.100.7", "198.51.100.6", "198.51.100.5", "198.51.100.4", "198.51.100.3"]);
	assert.equal(alert.detail.sources[0].failed, 17);
	assert.equal(alert.detail.total, 8);
});

test("auth_regression: a source that was at least 90% over 50 messages falls below 50% on 10 messages", () => {
	const prior = [src("192.0.2.1", 100, 90)];
	assert.deepEqual(kinds({ prior30: prior, yesterday: [src("192.0.2.1", 10, 4)] }), ["auth_regression"]);
	assert.deepEqual(kinds({ prior30: prior, yesterday: [src("192.0.2.1", 10, 5)] }), [], "exactly 50% is not below 50%");
	assert.deepEqual(kinds({ prior30: prior, yesterday: [src("192.0.2.1", 9, 0)] }), [], "fewer than 10 messages yesterday");
	assert.deepEqual(kinds({ prior30: [src("192.0.2.1", 100, 89)], yesterday: [src("192.0.2.1", 10, 0)] }), [], "89% was not good enough history");
	assert.deepEqual(kinds({ prior30: [src("192.0.2.1", 49, 49)], yesterday: [src("192.0.2.1", 10, 0)] }), [], "fewer than 50 messages of history");
});

test("a source that is both new and failing is spoofing, not a regression", () => {
	assert.deepEqual(kinds({ yesterday: [src("203.0.113.5", 50, 0)], prior30: [src("192.0.2.1", 100, 100)] }), ["spoofing"]);
	assert.deepEqual(kinds({ yesterday: [src("192.0.2.1", 50, 0)], prior30: [src("192.0.2.1", 100, 100)] }), ["auth_regression"]);
});

test("no_reports: enabled for 3 days and no report in 7 days, at most one alert a week", () => {
	const stale = { lastReportAt: new Date(NOW.getTime() - 8 * DAY) };
	assert.deepEqual(kinds(stale), ["no_reports"]);
	assert.deepEqual(kinds({ lastReportAt: new Date(NOW.getTime() - 7 * DAY + 1000) }), [], "a report within the last 7 days");
	assert.deepEqual(kinds({ lastReportAt: null }), ["no_reports"], "enabled long enough and never a report");
	assert.deepEqual(kinds({ lastReportAt: null, reportsEnabledAt: new Date(NOW.getTime() - 2 * DAY) }), [], "enabled less than 3 days ago");
	assert.deepEqual(kinds({ lastReportAt: null, reportsEnabledAt: new Date(NOW.getTime() - 3 * DAY) }), ["no_reports"], "exactly 3 days");
	assert.deepEqual(kinds({ lastReportAt: null, reportsEnabledAt: null }), [], "no enable time recorded");
	assert.deepEqual(kinds({ ...stale, lastNoReportsAlertAt: new Date(NOW.getTime() - 6 * DAY) }), [], "alerted 6 days ago");
	assert.deepEqual(kinds({ ...stale, lastNoReportsAlertAt: new Date(NOW.getTime() - 7 * DAY) }), ["no_reports"], "alerted 7 days ago");
});

test("nothing happens on a quiet day", () => {
	assert.deepEqual(kinds({}), []);
	assert.deepEqual(kinds({ yesterday: [src("192.0.2.1", 500, 500)], prior30: [src("192.0.2.1", 1000, 1000)] }), []);
});

test("thresholds are exported so docs and tests agree", () => {
	assert.deepEqual(ALERT_RULES, { spoofingMinFailed: 10, spoofTopSources: 5, regressionMinHistory: 50, regressionMinPass: 0.9, regressionMaxPass: 0.5, regressionMinToday: 10, noReportsEnabledDays: 3, noReportsSilentDays: 7, noReportsRepeatDays: 7 });
});

test("alerts from several reporters merge into one per kind, listing the busiest offenders with their reporter", () => {
	const one = (reporter, yesterday, prior30 = []) => ({ reporter, alerts: evaluateAlerts({ ...base, yesterday, prior30 }) });
	const merged = mergeReporterAlerts([
		one("google.com", [src("198.51.100.1", 12, 0), src("198.51.100.2", 40, 0)]),
		one("yahoo.com", [src("198.51.100.1", 30, 0)]),
		one("quiet.example", [src("192.0.2.9", 100, 100)]),
	]);
	assert.deepEqual(merged.map((alert) => alert.kind), ["spoofing"]);
	assert.equal(merged[0].detail.total, 3);
	assert.deepEqual(merged[0].detail.sources.map((entry) => [entry.reporter, entry.sourceIp, entry.failed]), [["google.com", "198.51.100.2", 40], ["yahoo.com", "198.51.100.1", 30], ["google.com", "198.51.100.1", 12]]);
	assert.deepEqual(mergeReporterAlerts([]), []);
});

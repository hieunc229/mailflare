import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function loadSummariseDns() {
	const src = readFileSync(join(root, "src/lib/dns-status.ts"), "utf8");
	const start = src.indexOf("export function summariseDns");
	assert.ok(start >= 0, "summariseDns not found in src/lib/dns-status.ts");
	const fnSrc = src
		.slice(start)
		.replace(/^export /, "")
		.replace(/: CfDnsRecord\[\]/g, "")
		.replace(/: DnsStatusSummary/g, "")
		.replace(/: "routing-records" \| "routing-missing" \| "sending"/g, "")
		.replace(/ as string\[\]/g, "");
	return new Function(`${fnSrc}\nreturn summariseDns;`)();
}

test("treats empty routing/sending records and empty missing as configured", () => {
	const summariseDns = loadSummariseDns();
	const summary = summariseDns([], [], []);
	assert.equal(summary.routing.configured, true);
	assert.deepEqual(summary.routing.missing, []);
	assert.equal(summary.sending.configured, true);
	assert.deepEqual(summary.sending.records, []);
});

test("marks routing as not configured when Cloudflare reports missing records", () => {
	const summariseDns = loadSummariseDns();
	const summary = summariseDns([], [{ type: "MX" }], []);
	assert.equal(summary.routing.configured, false);
	assert.deepEqual(summary.routing.missing, ["MX"]);
});

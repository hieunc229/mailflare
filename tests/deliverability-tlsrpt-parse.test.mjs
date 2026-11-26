import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(join(root, "tests", ".tmp-tlsrpt-parse-"));
after(() => rmSync(outDir, { recursive: true, force: true }));

await build({ entryPoints: { parse: join(root, "src/lib/deliverability/report-parse.ts") }, outdir: outDir, outExtension: { ".js": ".mjs" }, bundle: true, platform: "node", format: "esm", target: "node22", tsconfig: join(root, "tsconfig.json"), logLevel: "silent" });
const { REPORT_LIMITS, ReportError, extractReportXml, parseTlsRptJson, reportKey, rowKey, tlsRowKey } = await import(pathToFileURL(join(outDir, "parse.mjs")).href);

const fixture = () => readFileSync(join(root, "tests/fixtures/tlsrpt/google.json"), "utf8");
const bytes = (text) => new TextEncoder().encode(text);
const NOW = new Date("2025-11-19T12:00:00Z");
const opts = { hostname: "example.com", now: NOW };
const make = (change) => { const report = JSON.parse(fixture()); change(report); return JSON.stringify(report); };
const rejects = (text, pattern, status = "rejected") => assert.throws(() => parseTlsRptJson(text, opts), (error) => error instanceof ReportError && error.status === status && pattern.test(error.message));

test("extraction reads plain JSON and gzip JSON", async () => {
	assert.equal(await extractReportXml(bytes(fixture())), fixture());
	assert.equal(await extractReportXml(new Uint8Array(gzipSync(fixture()))), fixture());
});

test("a gzip bomb of JSON is cut off at the decompressed cap", async () => {
	const bomb = new Uint8Array(gzipSync(Buffer.from(`{"x":"${" ".repeat(REPORT_LIMITS.decompressedBytes + 1024)}"}`)));
	await assert.rejects(extractReportXml(bomb), (error) => error instanceof ReportError && /limit|ratio/i.test(error.message));
});

test("parses a Google-style report into per-result rows", () => {
	const report = parseTlsRptJson(fixture(), opts);
	assert.equal(report.reporterOrg, "Google Inc.");
	assert.equal(report.reporterEmail, "smtp-tls-reporting@google.com");
	assert.equal(report.reportId, "2025-11-18T00:00:00Z_example.com");
	assert.equal(report.day, "2025-11-18");
	assert.equal(report.dateBegin.toISOString(), "2025-11-18T00:00:00.000Z");
	assert.equal(report.recordCount, 2);
	assert.equal(report.messageCount, 130);
	const find = (policyType, resultType) => report.rows.find((row) => row.policyType === policyType && row.resultType === resultType);
	assert.deepEqual({ ...find("sts", "") }, { policyType: "sts", mxHost: "mail.example.com", resultType: "", success: 120, failure: 0 });
	assert.equal(find("sts", "certificate-expired").failure, 4);
	assert.equal(find("sts", "starttls-not-supported").failure, 2);
	assert.equal(find("sts", "unspecified").failure, 1, "the 7 total failures minus the 6 detailed ones");
	assert.equal(find("no-policy-found", "").success, 3);
	assert.equal(report.rows.length, 5);
});

test("a failure names the host that failed (receiving-mx-hostname); the policy pattern is the fallback", () => {
	const text = make((report) => {
		report.policies[0].policy["mx-host"] = ["*.example.com"];
		report.policies[0].policy["policy-domain"] = "example.com";
		report.policies[0]["failure-details"][0]["receiving-mx-hostname"] = "Bad.Mail.Example.com.";
		report.policies[0]["failure-details"][1]["receiving-mx-hostname"] = "not a host!";
	});
	const rows = parseTlsRptJson(text, opts).rows.filter((row) => row.policyType === "sts");
	const host = (resultType) => rows.find((row) => row.resultType === resultType).mxHost;
	assert.equal(host("certificate-expired"), "bad.mail.example.com");
	assert.equal(host("starttls-not-supported"), "*.example.com", "an invalid hostname falls back to the pattern");
	assert.equal(host(""), "*.example.com", "successes only know the pattern");
	assert.equal(host("unspecified"), "*.example.com");
});

test("rows with the same policy, host and result are summed", () => {
	const text = make((report) => { report.policies.push(structuredClone(report.policies[1])); });
	assert.equal(parseTlsRptJson(text, opts).rows.find((row) => row.policyType === "no-policy-found").success, 6);
});

test("the policy domain must be the configured domain or a subdomain; other policies in the report are ignored", () => {
	rejects(make((report) => { report.policies.forEach((policy) => { policy.policy["policy-domain"] = "other.test"; }); }), /domain mismatch/i);
	rejects(make((report) => { report.policies.forEach((policy) => { policy.policy["policy-domain"] = "com"; }); }), /domain mismatch/i);
	const sub = make((report) => { report.policies.forEach((policy) => { policy.policy["policy-domain"] = "mail.example.com"; }); });
	assert.equal(parseTlsRptJson(sub, opts).rows.length, 5);
	const mixed = make((report) => { report.policies[1].policy["policy-domain"] = "other.test"; });
	assert.deepEqual([...new Set(parseTlsRptJson(mixed, opts).rows.map((row) => row.policyType))], ["sts"]);
});

test("array lengths are bounded: 1,000 policies and 100 failure details", () => {
	const policy = (domain = "example.com") => ({ policy: { "policy-type": "sts", "policy-domain": domain }, summary: { "total-successful-session-count": 1, "total-failure-session-count": 0 } });
	assert.ok(parseTlsRptJson(make((report) => { report.policies = Array.from({ length: 1000 }, () => policy()); }), opts).rows.length >= 1);
	rejects(make((report) => { report.policies = Array.from({ length: 1001 }, () => policy()); }), /policies/i);
	const details = (count) => Array.from({ length: count }, (_, index) => ({ "result-type": `t${index}`, "failed-session-count": 1 }));
	assert.ok(parseTlsRptJson(make((report) => { report.policies[0]["failure-details"] = details(100); }), opts));
	rejects(make((report) => { report.policies[0]["failure-details"] = details(101); }), /failure/i);
});

test("deeply nested JSON is refused before it is parsed, in linear time", () => {
	const started = Date.now();
	rejects(`{"organization-name":"x","policies":${"[".repeat(200_000)}${"]".repeat(200_000)}}`, /nest/i);
	rejects(make((report) => { report.policies[0].extra = JSON.parse(`${"[".repeat(20)}${"]".repeat(20)}`); }), /nest/i);
	assert.ok(Date.now() - started < 1500);
	// A bracket inside a string is not nesting.
	assert.ok(parseTlsRptJson(make((report) => { report["organization-name"] = "[[[[[[[[[[[[[[[[[[[[[[[[[[ org"; }), opts));
});

test("counts must be whole numbers from 0 to 10 million", () => {
	for (const bad of [-1, 1.5, 10_000_001, "5", null, 1e30]) {
		rejects(make((report) => { report.policies[0].summary["total-successful-session-count"] = bad; }), /count/i);
		rejects(make((report) => { report.policies[0]["failure-details"][0]["failed-session-count"] = bad; }), /count/i);
	}
	assert.ok(parseTlsRptJson(make((report) => { report.policies[0].summary["total-successful-session-count"] = 10_000_000; }), opts));
});

test("dates are RFC 3339, inside the retention window and at most 7 days long", () => {
	const dated = (start, end) => make((report) => { report["date-range"] = { "start-datetime": start, "end-datetime": end }; });
	rejects(dated("2025-11-18", "2025-11-19"), /date/i, "failed");
	rejects(dated("yesterday", "today"), /date/i, "failed");
	rejects(dated("2024-01-01T00:00:00Z", "2024-01-02T00:00:00Z"), /window/i);
	rejects(dated("2026-12-01T00:00:00Z", "2026-12-02T00:00:00Z"), /window/i);
	rejects(dated("2025-11-10T00:00:00Z", "2025-11-19T00:00:00Z"), /7 days/i);
	assert.equal(parseTlsRptJson(dated("2025-11-18T22:00:00-05:00", "2025-11-19T00:00:00Z"), opts).day, "2025-11-19", "the UTC day of the start");
	rejects(make((report) => { delete report["date-range"]; }), /date/i, "failed");
});

test("required fields, the root shape and unknown values", () => {
	rejects("[]", /not a TLS-RPT/i);
	rejects("{}", /not a TLS-RPT/i);
	rejects("null", /not a TLS-RPT/i);
	rejects(make((report) => { delete report["organization-name"]; }), /organization-name|report-id/i, "failed");
	rejects(make((report) => { delete report["report-id"]; }), /organization-name|report-id/i, "failed");
	rejects(make((report) => { report.policies = []; }), /no (policies|usable)/i, "failed");
	const unknown = parseTlsRptJson(make((report) => { report.policies[1].policy["policy-type"] = "weird"; }), opts);
	assert.ok(!unknown.rows.some((row) => row.policyType === "weird"));
});

test("fields are cleaned: lengths cut, result types limited to a safe alphabet, host names validated", () => {
	const text = make((report) => {
		report["organization-name"] = "O".repeat(500);
		report["report-id"] = "r".repeat(1000);
		report["contact-info"] = `${"c".repeat(400)}@x.test`;
		report.policies[0]["failure-details"][0]["result-type"] = "Evil<script>";
		report.policies[0].policy["mx-host"] = ["not a host!", "ok.example.com"];
	});
	const report = parseTlsRptJson(text, opts);
	assert.equal(report.reporterOrg.length, REPORT_LIMITS.org);
	assert.equal(report.reportId.length, REPORT_LIMITS.reportId);
	assert.ok(report.reporterEmail === null || report.reporterEmail.length <= REPORT_LIMITS.email);
	assert.ok(report.rows.every((row) => /^[a-z0-9-]{0,64}$/.test(row.resultType)));
	assert.ok(report.rows.some((row) => row.resultType === "other"));
	assert.equal(report.rows.find((row) => row.policyType === "sts").mxHost, "ok.example.com");
});

test("the row cap keeps the highest-volume rows", () => {
	const text = make((report) => {
		report.policies = Array.from({ length: 600 }, (_, index) => ({ policy: { "policy-type": "sts", "policy-domain": "example.com", "mx-host": [`mx${index}.example.com`] }, summary: { "total-successful-session-count": index + 1, "total-failure-session-count": 0 } }));
	});
	const report = parseTlsRptJson(text, opts);
	assert.equal(report.rows.length, REPORT_LIMITS.rows);
	assert.equal(report.truncated, true);
	assert.equal(Math.min(...report.rows.map((row) => row.success)), 101);
});

test("a __proto__ key in the report changes nothing outside it", () => {
	const text = fixture().replace('"policies"', '"__proto__": {"polluted": true}, "policies"');
	assert.ok(parseTlsRptJson(text, opts));
	assert.equal({}.polluted, undefined);
});

test("keys: a TLS-RPT report never collides with a DMARC report, rows differ by every field", async () => {
	assert.notEqual(await reportKey("google.com", "id1", true, "tlsrpt"), await reportKey("google.com", "id1", true));
	assert.equal(await reportKey("google.com", "id1", true), await reportKey("google.com", "id1", true, "dmarc"));
	const row = { policyType: "sts", mxHost: "mx.example.com", resultType: "" };
	const base = await tlsRowKey("google.com", row);
	assert.equal(await tlsRowKey("google.com", { ...row }), base);
	for (const changed of [await tlsRowKey("bing.com", row), await tlsRowKey("google.com", { ...row, policyType: "tlsa" }), await tlsRowKey("google.com", { ...row, mxHost: null }), await tlsRowKey("google.com", { ...row, resultType: "x" })]) assert.notEqual(changed, base);
	assert.notEqual(base, await rowKey("google.com", { sourceIp: "1.1.1.1", headerFrom: "a", disposition: "none", dkimAligned: true, spfAligned: true }));
});

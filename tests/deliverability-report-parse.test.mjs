import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { randomBytes } from "node:crypto";
import { deflateRawSync, gzipSync } from "node:zlib";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(join(root, "tests", ".tmp-report-parse-"));
after(() => rmSync(outDir, { recursive: true, force: true }));

await build({ entryPoints: { parse: join(root, "src/lib/deliverability/report-parse.ts") }, outdir: outDir, outExtension: { ".js": ".mjs" }, bundle: true, platform: "node", format: "esm", target: "node22", tsconfig: join(root, "tsconfig.json"), logLevel: "silent" });
const parse = await import(pathToFileURL(join(outDir, "parse.mjs")).href);
const { REPORT_LIMITS, ReportError, extractReportXml, parseDmarcAggregateXml, reportKey, rowKey } = parse;

const fixture = (name) => readFileSync(join(root, "tests/fixtures/dmarc", name), "utf8");
const bytes = (text) => new TextEncoder().encode(text);
const NOW = new Date("2025-11-19T12:00:00Z");
const opts = { hostname: "example.com", now: NOW };

// A minimal zip writer so the tests control every header field (declared size, flags, entry count).
function zip(entries, { declaredSize, flags = 0 } = {}) {
	const locals = [];
	const central = [];
	let offset = 0;
	for (const entry of entries) {
		const name = Buffer.from(entry.name);
		const method = entry.method ?? 8;
		const data = method === 8 ? deflateRawSync(entry.data) : Buffer.from(entry.data);
		const local = Buffer.alloc(30);
		local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(flags, 6); local.writeUInt16LE(method, 8);
		local.writeUInt32LE(data.length, 18); local.writeUInt32LE(declaredSize ?? entry.data.length, 22); local.writeUInt16LE(name.length, 26);
		locals.push(local, name, data);
		const dir = Buffer.alloc(46);
		dir.writeUInt32LE(0x02014b50, 0); dir.writeUInt16LE(20, 4); dir.writeUInt16LE(20, 6); dir.writeUInt16LE(flags, 8); dir.writeUInt16LE(method, 10);
		dir.writeUInt32LE(data.length, 20); dir.writeUInt32LE(declaredSize ?? entry.data.length, 24); dir.writeUInt16LE(name.length, 28); dir.writeUInt32LE(offset, 42);
		central.push(dir, name);
		offset += local.length + name.length + data.length;
	}
	const directory = Buffer.concat(central);
	const eocd = Buffer.alloc(22);
	eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(entries.length, 8); eocd.writeUInt16LE(entries.length, 10); eocd.writeUInt32LE(directory.length, 12); eocd.writeUInt32LE(offset, 16);
	return new Uint8Array(Buffer.concat([...locals, directory, eocd]));
}

// ---- extraction and bombs -------------------------------------------------------

test("extracts plain XML, gzip and a single-entry zip", async () => {
	const xml = fixture("google.xml");
	assert.equal(await extractReportXml(bytes(xml)), xml);
	assert.equal(await extractReportXml(new Uint8Array(gzipSync(xml))), xml);
	assert.equal(await extractReportXml(zip([{ name: "google.com!example.com!1.xml", data: xml }])), xml);
	assert.equal(await extractReportXml(zip([{ name: "stored.xml", data: xml, method: 0 }])), xml);
});

test("a gzip bomb stops at the decompressed cap even though its header is tiny", async () => {
	const bomb = new Uint8Array(gzipSync(Buffer.alloc(REPORT_LIMITS.decompressedBytes + 1024, 0x20)));
	assert.ok(bomb.length < 20_000, "fixture really is a tiny compressed bomb");
	await assert.rejects(extractReportXml(bomb), (error) => error instanceof ReportError && /limit|ratio/i.test(error.message));
});

test("a payload that expands past the ratio is refused before the byte cap", async () => {
	const body = Buffer.alloc(3 * 1024 * 1024, 0x20); // 3 MiB of spaces compresses to ~3 KiB: ratio above 1000
	const payload = new Uint8Array(gzipSync(body));
	assert.ok(body.length / payload.length > REPORT_LIMITS.maxExpansionRatio);
	await assert.rejects(extractReportXml(payload), (error) => error instanceof ReportError && /ratio|limit/i.test(error.message));
});

test("the ratio cap is 1000x, so a well-compressed but genuine report is not refused", async () => {
	assert.equal(REPORT_LIMITS.maxExpansionRatio, 1000);
	const body = Buffer.from("<record><row><source_ip>203.0.113.7</source_ip><count>42</count></row></record>\n".repeat(6000));
	const payload = new Uint8Array(gzipSync(body));
	assert.ok(body.length / payload.length > 100 && body.length / payload.length < 1000, `ratio ${body.length / payload.length}`);
	assert.equal((await extractReportXml(payload)).length, body.length);
});

test("decompression input is fed in 16 KiB slices, so the byte cap holds whatever chunking the runtime uses", async () => {
	const sizes = [];
	const Real = globalThis.DecompressionStream;
	globalThis.DecompressionStream = class {
		constructor(format) {
			const real = new Real(format);
			const spy = new TransformStream({ transform(chunk, controller) { sizes.push(chunk.byteLength); controller.enqueue(chunk); } });
			spy.readable.pipeTo(real.writable).catch(() => undefined);
			this.writable = spy.writable;
			this.readable = real.readable;
		}
	};
	try {
		const body = Buffer.from(randomBytes(120_000).toString("base64"));
		await extractReportXml(new Uint8Array(gzipSync(body)));
		const gzipSizes = sizes.splice(0);
		await extractReportXml(zip([{ name: "a.xml", data: body }]));
		for (const seen of [gzipSizes, sizes]) {
			assert.ok(seen.length > 4, "the input was split");
			assert.ok(Math.max(...seen) <= 16 * 1024, `largest slice ${Math.max(...seen)}`);
		}
	} finally {
		globalThis.DecompressionStream = Real;
	}
});

test("a gzip bomb of 64 MiB of zeros is cut off at the cap", async () => {
	const bomb = new Uint8Array(gzipSync(Buffer.alloc(64 * 1024 * 1024)));
	assert.ok(bomb.length < 100_000);
	await assert.rejects(extractReportXml(bomb), (error) => error instanceof ReportError && error.status === "rejected");
});

test("a zip whose header lies about the size is still cut off by the byte counter", async () => {
	const big = Buffer.alloc(REPORT_LIMITS.decompressedBytes + 1024, 0x20);
	await assert.rejects(extractReportXml(zip([{ name: "a.xml", data: big }], { declaredSize: 100 })), (error) => error instanceof ReportError);
});

test("a zip that declares a 50 MB entry is refused from the directory alone", async () => {
	await assert.rejects(extractReportXml(zip([{ name: "a.xml", data: "<feedback/>" }], { declaredSize: 50 * 1024 * 1024 })), (error) => error instanceof ReportError && /size/i.test(error.message));
});

test("zip with two entries, an encrypted entry, a non-xml name or an unsupported method is refused", async () => {
	const xml = "<feedback/>";
	await assert.rejects(extractReportXml(zip([{ name: "a.xml", data: xml }, { name: "b.xml", data: xml }])), /exactly one/i);
	await assert.rejects(extractReportXml(zip([{ name: "a.xml", data: xml }], { flags: 1 })), /encrypted/i);
	await assert.rejects(extractReportXml(zip([{ name: "a.exe", data: xml }])), /\.xml/i);
	await assert.rejects(extractReportXml(zip([{ name: "a.xml", data: xml, method: 9 }])), (error) => error instanceof ReportError);
});

test("oversized compressed input and unknown formats are refused", async () => {
	await assert.rejects(extractReportXml(new Uint8Array(REPORT_LIMITS.compressedBytes + 1).fill(0x1f)), /limit/i);
	await assert.rejects(extractReportXml(bytes("hello world")), /not a report/i);
	await assert.rejects(extractReportXml(new Uint8Array([0x1f, 0x8b, 1, 2, 3])), (error) => error instanceof ReportError);
});

// ---- DMARC XML ------------------------------------------------------------------

test("parses a Google-style report", () => {
	const report = parseDmarcAggregateXml(fixture("google.xml"), opts);
	assert.equal(report.reporterOrg, "google.com");
	assert.equal(report.reporterEmail, "noreply-dmarc-support@google.com");
	assert.equal(report.reportId, "13993201926883216094");
	assert.equal(report.dateBegin.toISOString(), "2025-11-18T00:00:00.000Z");
	assert.equal(report.day, "2025-11-18");
	assert.equal(report.policyDomain, "example.com");
	assert.equal(report.policyP, "none");
	assert.equal(report.policyPct, 100);
	assert.equal(report.recordCount, 3);
	assert.equal(report.messageCount, 50);
	assert.deepEqual(report.rows.map((row) => [row.sourceIp, row.count, row.disposition, row.dkimAligned, row.spfAligned, row.headerFrom]), [
		["203.0.113.7", 42, "none", true, true, "example.com"],
		["198.51.100.23", 5, "reject", false, false, "example.com"],
		["2001:db8::25", 3, "quarantine", false, true, "mail.example.com"],
	]);
});

test("parses a namespaced Microsoft-style report, lower-casing header_from and unescaping entities", () => {
	const report = parseDmarcAggregateXml(fixture("microsoft.xml"), opts);
	assert.equal(report.reporterOrg, "Outlook.com");
	assert.equal(report.policyP, "quarantine");
	assert.equal(report.policyPct, 50);
	assert.deepEqual(report.rows.map((row) => [row.headerFrom, row.dkimAligned, row.spfAligned, row.count]), [["example.com", true, false, 7]]);
});

test("rows with the same source and result are summed", () => {
	const record = (count) => `<record><row><source_ip>192.0.2.1</source_ip><count>${count}</count><policy_evaluated><disposition>none</disposition><dkim>pass</dkim><spf>pass</spf></policy_evaluated></row><identifiers><header_from>example.com</header_from></identifiers></record>`;
	const xml = fixture("google.xml").replace(/<record>[\s\S]*<\/record>/, record(2) + record(3));
	const report = parseDmarcAggregateXml(xml, opts);
	assert.equal(report.recordCount, 2);
	assert.deepEqual(report.rows.map((row) => row.count), [5]);
});

test("DOCTYPE and ENTITY declarations are rejected, never expanded", () => {
	const lol = `<?xml version="1.0"?><!DOCTYPE feedback [<!ENTITY a "aaaaaaaaaa"><!ENTITY b "&a;&a;&a;&a;&a;&a;&a;&a;&a;&a;">]>` + fixture("google.xml").replace(/^<\?xml[^>]*>/, "").replace("example.com</org_name>", "&b;</org_name>");
	assert.throws(() => parseDmarcAggregateXml(lol, opts), (error) => error instanceof ReportError && error.status === "rejected" && /doctype|entit/i.test(error.message));
	assert.throws(() => parseDmarcAggregateXml(fixture("google.xml").replace("<feedback>", `<!ENTITY x SYSTEM "file:///etc/passwd"><feedback>`), opts), (error) => error.status === "rejected");
});

test("more than 20,000 records is rejected; exactly 20,000 is read", () => {
	const record = (index) => `<record><row><source_ip>10.0.${index >> 8 & 255}.${index & 255}</source_ip><count>1</count><policy_evaluated><disposition>none</disposition><dkim>pass</dkim><spf>pass</spf></policy_evaluated></row><identifiers><header_from>example.com</header_from></identifiers></record>`;
	const head = fixture("google.xml").replace(/<record>[\s\S]*<\/record>/, "@@");
	const many = (n) => head.replace("@@", Array.from({ length: n }, (_, index) => record(index)).join(""));
	const ok = parseDmarcAggregateXml(many(REPORT_LIMITS.records), opts);
	assert.equal(ok.recordCount, REPORT_LIMITS.records);
	assert.equal(ok.rows.length, REPORT_LIMITS.rows, "distinct rows are capped, highest volume first");
	assert.equal(ok.truncated, true);
	assert.throws(() => parseDmarcAggregateXml(many(REPORT_LIMITS.records + 1), opts), (error) => error.status === "rejected" && /records/i.test(error.message));
});

test("the row cap keeps the highest-volume rows", () => {
	const record = (ip, count) => `<record><row><source_ip>${ip}</source_ip><count>${count}</count><policy_evaluated><disposition>none</disposition><dkim>pass</dkim><spf>pass</spf></policy_evaluated></row><identifiers><header_from>example.com</header_from></identifiers></record>`;
	const body = Array.from({ length: REPORT_LIMITS.rows + 5 }, (_, index) => record(`10.1.${index >> 8}.${index & 255}`, index === 3 ? 999 : 1)).join("");
	const report = parseDmarcAggregateXml(fixture("google.xml").replace(/<record>[\s\S]*<\/record>/, body), opts);
	assert.equal(report.rows.length, REPORT_LIMITS.rows);
	assert.equal(report.rows[0].count, 999);
	assert.equal(report.messageCount, REPORT_LIMITS.rows + 5 - 1 + 999);
});

test("an unclosed-tag flood parses in linear time", () => {
	const flood = "<record>".repeat(15_000) + "<row>".repeat(500_000);
	const started = performance.now();
	assert.throws(() => parseDmarcAggregateXml(`<feedback><report_metadata><org_name>x</org_name></report_metadata>${flood}`, opts), ReportError);
	assert.ok(performance.now() - started < 1500, "must not be quadratic");
});

test("domain mismatch is rejected; a subdomain of the configured domain is accepted; its parent is not", () => {
	const withDomain = (domain) => fixture("google.xml").replace("<domain>example.com</domain>\n    <adkim>", `<domain>${domain}</domain>\n    <adkim>`);
	assert.throws(() => parseDmarcAggregateXml(withDomain("other.org"), opts), (error) => error.status === "rejected" && /domain mismatch/i.test(error.message));
	assert.throws(() => parseDmarcAggregateXml(withDomain("notexample.com"), opts), (error) => error.status === "rejected");
	assert.equal(parseDmarcAggregateXml(withDomain("Sub.Example.com."), opts).policyDomain, "sub.example.com");
	assert.throws(() => parseDmarcAggregateXml(withDomain("example.com"), { hostname: "mail.example.com", now: NOW }), (error) => error.status === "rejected");
});

test("dates outside the window are rejected", () => {
	const at = (begin) => fixture("google.xml").replace("<begin>1763424000</begin>", `<begin>${begin}</begin>`);
	const day = 86400;
	const now = Math.floor(NOW.getTime() / 1000);
	assert.throws(() => parseDmarcAggregateXml(at(now + 3 * day), opts), (error) => error.status === "rejected" && /date/i.test(error.message));
	assert.throws(() => parseDmarcAggregateXml(at(now - 200 * day), opts), (error) => error.status === "rejected" && /date/i.test(error.message));
	assert.throws(() => parseDmarcAggregateXml(at("abc"), opts), (error) => error instanceof ReportError);
});

test("fields are truncated, invalid IPs and counts are skipped, unknown enums fall back", () => {
	const longOrg = "o".repeat(500);
	const xml = fixture("google.xml")
		.replace("<org_name>google.com</org_name>", `<org_name>${longOrg}</org_name>`)
		.replace(/<record>[\s\S]*<\/record>/, [
			`<record><row><source_ip>not-an-ip</source_ip><count>5</count><policy_evaluated><disposition>none</disposition><dkim>pass</dkim><spf>pass</spf></policy_evaluated></row><identifiers><header_from>example.com</header_from></identifiers></record>`,
			`<record><row><source_ip>192.0.2.9</source_ip><count>-4</count><policy_evaluated><disposition>none</disposition><dkim>pass</dkim><spf>pass</spf></policy_evaluated></row><identifiers><header_from>example.com</header_from></identifiers></record>`,
			`<record><row><source_ip>192.0.2.8</source_ip><count>2</count><policy_evaluated><disposition>weird</disposition><dkim>neutral</dkim><spf>softfail</spf></policy_evaluated></row><identifiers><header_from>${"h".repeat(400)}.example.com</header_from></identifiers></record>`,
		].join(""));
	const report = parseDmarcAggregateXml(xml, opts);
	assert.equal(report.reporterOrg.length, REPORT_LIMITS.org);
	assert.equal(report.recordCount, 3);
	assert.equal(report.rows.length, 1);
	assert.deepEqual([report.rows[0].disposition, report.rows[0].dkimAligned, report.rows[0].spfAligned], ["none", false, false]);
	assert.equal(report.rows[0].headerFrom.length, REPORT_LIMITS.domain);
});

test("input that is not a DMARC feedback document is rejected", () => {
	assert.throws(() => parseDmarcAggregateXml("<html><body>hi</body></html>", opts), (error) => error.status === "rejected");
	assert.throws(() => parseDmarcAggregateXml("<feedback><report_metadata><org_name>x</org_name></report_metadata></feedback>", opts), (error) => error instanceof ReportError);
});

// ---- scanner robustness -------------------------------------------------------

const google = () => fixture("google.xml");

test("comments are ignored: a commented-out id or record never counts", () => {
	const xml = google()
		.replace("<report_metadata>", "<report_metadata><!-- <report_id>FAKE</report_id> -->")
		.replace("<record>", "<!-- <record><row><source_ip>192.0.2.99</source_ip><count>500</count></row></record> --><record>");
	const report = parseDmarcAggregateXml(xml, opts);
	assert.equal(report.reportId, "13993201926883216094");
	assert.equal(report.recordCount, 3);
	assert.equal(report.messageCount, 50);
	assert.throws(() => parseDmarcAggregateXml(google().replace("<record>", "<!-- never closed <record>"), opts), (error) => error instanceof ReportError);
});

test("a comment inside CDATA is text, not a comment", () => {
	const xml = google().replace("<org_name>google.com</org_name>", "<org_name><![CDATA[go<!--ogle]]></org_name>");
	assert.equal(parseDmarcAggregateXml(xml, opts).reporterOrg, "go<!--ogle");
});

test("a closing tag may carry whitespace before its >", () => {
	const report = parseDmarcAggregateXml(google().replace("</org_name>", "</org_name\n >").replace(/<\/record>/g, "</record >"), opts);
	assert.equal(report.reporterOrg, "google.com");
	assert.equal(report.recordCount, 3);
});

test("namespace-prefixed element names match by local name", () => {
	const prefixed = google().replace(/<(\/?)([a-z_]+)/g, "<$1d:$2").replace("<d:feedback", '<d:feedback xmlns:d="urn:x"');
	const plain = parseDmarcAggregateXml(google(), opts);
	const report = parseDmarcAggregateXml(prefixed, opts);
	assert.equal(report.reporterOrg, plain.reporterOrg);
	assert.equal(report.recordCount, 3);
	assert.deepEqual(report.rows, plain.rows);
});

test("numeric character references are decoded within bounds, and decoding is single-pass", () => {
	const org = (value) => parseDmarcAggregateXml(google().replace("<org_name>google.com</org_name>", `<org_name>${value}</org_name>`), opts).reporterOrg;
	assert.equal(org("a&#66;&#x43;&#233;&#x1F600;"), "aBC\u00e9\u{1F600}");
	assert.equal(org("&#38;lt;"), "&lt;");
	assert.equal(org("&amp;#65;"), "&#65;");
	assert.equal(org("x&#x110000;y&#xD800;z&#99999999;"), "x&#x110000;y&#xD800;z&#99999999;");
	assert.equal(org("a&#0;b&#7;c"), "a&#0;bc", "invalid references stay literal; a decoded control character is dropped");
});

test("a > inside a quoted attribute value does not end the tag", () => {
	const xml = google().replace("<org_name>google.com</org_name>", `<org_name note="a>b" other='c>d'>google.com</org_name>`).replace("<record>", `<record x="1>2">`);
	const report = parseDmarcAggregateXml(xml, opts);
	assert.equal(report.reporterOrg, "google.com");
	assert.equal(report.recordCount, 3);
});

test("per-row counts above 10,000,000 are skipped, exactly 10,000,000 is kept", () => {
	assert.equal(REPORT_LIMITS.maxCount, 10_000_000);
	const record = (count) => `<record><row><source_ip>192.0.2.1</source_ip><count>${count}</count><policy_evaluated><disposition>none</disposition><dkim>pass</dkim><spf>pass</spf></policy_evaluated></row><identifiers><header_from>example.com</header_from></identifiers></record>`;
	const at = (count) => parseDmarcAggregateXml(google().replace(/<record>[\s\S]*<\/record>/, record(count) + record(1).replace("192.0.2.1", "192.0.2.2")), opts);
	assert.deepEqual(at(10_000_000).rows.map((row) => row.count), [10_000_000, 1]);
	assert.deepEqual(at(10_000_001).rows.map((row) => row.count), [1]);
});

test("a report whose date range is longer than 7 days is rejected", () => {
	const begin = 1763424000;
	const ranged = (days) => google().replace(/<end>\d+<\/end>/, `<end>${begin + days * 86400}</end>`);
	assert.equal(parseDmarcAggregateXml(ranged(7), opts).dateEnd.getTime(), (begin + 7 * 86400) * 1000);
	assert.throws(() => parseDmarcAggregateXml(ranged(8), opts), (error) => error.status === "rejected" && /range/i.test(error.message));
});

test("comment, CDATA and quote floods parse in linear time", () => {
	const head = "<feedback><report_metadata><org_name>x</org_name></report_metadata>";
	for (const flood of ["<!-- a -->".repeat(100_000) + "<![CDATA[".repeat(10) , '<record a="'.repeat(100_000), "<![CDATA[ <!--".repeat(50_000), "<d:record ".repeat(100_000)]) {
		const started = performance.now();
		assert.throws(() => parseDmarcAggregateXml(head + flood, opts), ReportError);
		assert.ok(performance.now() - started < 1500, `quadratic on ${flood.slice(0, 12)}`);
	}
});

test("report_key and row_key are stable hex digests that vary with their inputs", async () => {
	const a = await reportKey("google.com", "123", true);
	assert.match(a, /^[0-9a-f]{64}$/);
	assert.equal(a, await reportKey("google.com", "123", true));
	assert.notEqual(a, await reportKey("google.com", "124", true));
	assert.notEqual(await reportKey("ab", "c", true), await reportKey("a", "bc", true), "fields are separated");
	assert.notEqual(a, await reportKey("google.com", "123", false), "an unverified report can never claim a verified report's key");
	const row = { sourceIp: "192.0.2.1", headerFrom: "example.com", disposition: "none", dkimAligned: true, spfAligned: false };
	const k = await rowKey("google.com", row);
	assert.match(k, /^[0-9a-f]{64}$/);
	assert.notEqual(k, await rowKey("google.com", { ...row, spfAligned: true }));
	assert.notEqual(k, await rowKey("yahoo.com", row), "rows of different verified reporters never merge");
});

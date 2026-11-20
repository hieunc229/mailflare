import { reverseName } from "@/lib/dns-query";
import { listZipEntries, openZipEntry, sliceChunks } from "@/lib/import/zip-utils";

/**
 * Pure, bounded parsing of DMARC aggregate (rua) reports. Report mail is attacker-controlled, so every
 * stage has a cap: compressed size, decompressed size and expansion ratio, zip entry count, record count,
 * distinct rows and field lengths. Nothing here fetches a URL or expands an XML entity.
 */
export const REPORT_LIMITS = Object.freeze({
	rawMessageBytes: 5 * 1024 * 1024,
	compressedBytes: 3 * 1024 * 1024,
	decompressedBytes: 8 * 1024 * 1024,
	/** Decompressed bytes may not exceed this multiple of the compressed bytes ... */
	maxExpansionRatio: 1000,
	/** Compressed input reaches the inflater in slices of this size, so one write can only expand so far before the byte counter looks. */
	inputSliceBytes: 16 * 1024,
	/** ... except that anything up to this size is always allowed, so tiny valid reports never trip the ratio. */
	ratioFloorBytes: 64 * 1024,
	records: 20_000,
	/** Distinct (source, result) rows written per report, highest volume first. */
	rows: 500,
	/** A per-row count above this is not a real mail volume for one source and result in one report. */
	maxCount: 10_000_000,
	ip: 45,
	domain: 253,
	org: 128,
	email: 254,
	reportId: 256,
	/** A report may start at most this far in the future, and at most this long ago (the retention window). */
	maxFutureSeconds: 24 * 60 * 60,
	maxAgeSeconds: 180 * 24 * 60 * 60,
	/** Reports cover a day; a longer range is refused, so one report cannot be spread over a long period. */
	maxRangeSeconds: 7 * 24 * 60 * 60,
});

export class ReportError extends Error {
	constructor(readonly status: "rejected" | "failed", message: string) {
		super(message);
	}
}

export type DmarcRow = { sourceIp: string; headerFrom: string; disposition: "none" | "quarantine" | "reject"; dkimAligned: boolean; spfAligned: boolean; count: number };

export type DmarcReport = {
	reporterOrg: string;
	reporterEmail: string | null;
	reportId: string;
	dateBegin: Date;
	dateEnd: Date;
	/** UTC day (YYYY-MM-DD) the report window began; the whole report is attributed to it. */
	day: string;
	policyDomain: string;
	policyP: "none" | "quarantine" | "reject" | null;
	policyPct: number | null;
	recordCount: number;
	messageCount: number;
	rows: DmarcRow[];
	/** More distinct rows than REPORT_LIMITS.rows; the lowest-volume ones were dropped. */
	truncated: boolean;
};

// ---- extraction -----------------------------------------------------------------

async function readCapped(stream: ReadableStream<Uint8Array>, limit: number): Promise<Uint8Array> {
	const reader = stream.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			total += value.length;
			if (total > limit) throw new ReportError("rejected", "Decompressed size exceeds the limit or expansion ratio");
			chunks.push(value);
		}
	} finally {
		await reader.cancel().catch(() => undefined);
	}
	const out = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.length; }
	return out;
}

const startsWith = (bytes: Uint8Array, ...prefix: number[]) => prefix.every((byte, index) => bytes[index] === byte);

/** Turns a report attachment (zip, gzip or plain XML, detected by content) into XML text, within the limits. */
export async function extractReportXml(bytes: Uint8Array): Promise<string> {
	if (bytes.length > REPORT_LIMITS.compressedBytes) throw new ReportError("rejected", "Attachment exceeds the size limit");
	const allowed = Math.min(REPORT_LIMITS.decompressedBytes, Math.max(REPORT_LIMITS.ratioFloorBytes, bytes.length * REPORT_LIMITS.maxExpansionRatio));
	try {
		let raw: Uint8Array;
		if (startsWith(bytes, 0x1f, 0x8b)) {
			const input = new Blob([bytes as BlobPart]).stream().pipeThrough(sliceChunks(REPORT_LIMITS.inputSliceBytes));
			raw = await readCapped(input.pipeThrough(new DecompressionStream("gzip") as unknown as TransformStream<Uint8Array, Uint8Array>), allowed);
		} else if (startsWith(bytes, 0x50, 0x4b, 0x03, 0x04)) {
			const blob = new Blob([bytes as BlobPart]);
			const entries = await listZipEntries(blob);
			if (entries.length !== 1) throw new ReportError("rejected", "A report zip must contain exactly one file");
			const [entry] = entries;
			if (entry.encrypted) throw new ReportError("rejected", "The report zip is encrypted");
			if (entry.method !== 0 && entry.method !== 8) throw new ReportError("rejected", "The report zip uses an unsupported compression method");
			if (!/\.xml$/i.test(entry.name)) throw new ReportError("rejected", "The report zip entry is not an .xml file");
			// The declared size is checked first but never trusted: the byte counter below is what enforces the cap.
			if (entry.size > allowed) throw new ReportError("rejected", "Declared size exceeds the limit or expansion ratio");
			raw = await readCapped(await openZipEntry(blob, entry, { maxInputBytes: REPORT_LIMITS.inputSliceBytes }), allowed);
		} else {
			const head = new TextDecoder().decode(bytes.subarray(0, 64)).replace(/^﻿/, "").trimStart();
			if (!head.startsWith("<")) throw new ReportError("rejected", "The attachment is not a report");
			raw = bytes;
		}
		return new TextDecoder().decode(raw).replace(/^﻿/, "");
	} catch (error) {
		if (error instanceof ReportError) throw error;
		throw new ReportError("failed", `Could not read the attachment: ${error instanceof Error ? error.message : "unknown error"}`.slice(0, 300));
	}
}

// ---- XML (linear-time, no entity expansion) --------------------------------------

const NAME_PREFIX = "(?:[A-Za-z_][\\w.-]*:)?";
const patterns = new Map<string, { open: RegExp; close: RegExp }>();

/** Matchers for `<name` and `</name >`, with an optional namespace prefix so `<d:record>` is found as `record`. */
function tagPatterns(name: string) {
	let found = patterns.get(name);
	if (!found) {
		found = { open: new RegExp(`<${NAME_PREFIX}${name}(?=[\\s/>])`, "g"), close: new RegExp(`</${NAME_PREFIX}${name}\\s*>`, "g") };
		patterns.set(name, found);
	}
	return found;
}

/** Index of the `>` that ends a tag whose name ended at `from`, skipping a `>` inside a quoted attribute value; -1 when there is none. */
function tagEnd(source: string, from: number): number {
	let quote = 0;
	for (let index = from; index < source.length; index += 1) {
		const code = source.charCodeAt(index);
		if (quote) {
			if (code === quote) quote = 0;
		} else if (code === 34 || code === 39) quote = code;
		else if (code === 62) return index;
	}
	return -1;
}

/** Removes `<!-- -->` comments outside CDATA in one linear pass, so a commented-out id or record is never read. */
function stripComments(xml: string): string {
	if (xml.indexOf("<!--") < 0) return xml;
	const parts: string[] = [];
	let at = 0;
	let cdata = xml.indexOf("<![CDATA[");
	for (;;) {
		const comment = xml.indexOf("<!--", at);
		if (comment < 0) break;
		if (cdata >= 0 && cdata < at) cdata = xml.indexOf("<![CDATA[", at);
		if (cdata >= 0 && cdata < comment) {
			const end = xml.indexOf("]]>", cdata + 9);
			const stop = end < 0 ? xml.length : end + 3;
			parts.push(xml.slice(at, stop));
			at = stop;
			continue;
		}
		const end = xml.indexOf("-->", comment + 4);
		if (end < 0) throw new ReportError("rejected", "Unterminated comment");
		parts.push(xml.slice(at, comment));
		at = end + 3;
	}
	parts.push(xml.slice(at));
	return parts.join("");
}

/** The inner text of the first `<name>` at or after `from`. Regex searches and indexOf scans only move forward, so hostile nesting stays linear. */
function readTag(source: string, name: string, from = 0): { inner: string; next: number } | null {
	const { open, close } = tagPatterns(name);
	open.lastIndex = from;
	const start = open.exec(source);
	if (!start) return null;
	const gt = tagEnd(source, start.index + start[0].length);
	if (gt < 0) return null;
	if (source.charCodeAt(gt - 1) === 47) return { inner: "", next: gt + 1 };
	close.lastIndex = gt + 1;
	const end = close.exec(source);
	if (!end) return null;
	return { inner: source.slice(gt + 1, end.index), next: end.index + end[0].length };
}

function countTags(source: string, name: string, limit: number): number {
	const { open } = tagPatterns(name);
	open.lastIndex = 0;
	let count = 0;
	while (count <= limit && open.exec(source)) count += 1;
	return count;
}

const ENTITIES: Record<string, string> = { lt: "<", gt: ">", quot: '"', apos: "'", amp: "&" };
const validCodePoint = (code: number) => code >= 1 && code <= 0x10ffff && (code < 0xd800 || code > 0xdfff);

/** One pass, so `&amp;lt;` becomes `&lt;` and never `<`. An out-of-range numeric reference is left as written. */
const unescapeXml = (value: string) => value.replace(/&(?:(lt|gt|quot|apos|amp)|#(\d{1,7})|#x([0-9a-fA-F]{1,6}));/g, (whole, name?: string, decimal?: string, hex?: string) => {
	if (name) return ENTITIES[name];
	const code = decimal !== undefined ? Number(decimal) : Number.parseInt(hex as string, 16);
	return validCodePoint(code) ? String.fromCodePoint(code) : whole;
});

function text(source: string, name: string, max: number): string {
	const raw = readTag(source, name)?.inner ?? "";
	const cdata = /^\s*<!\[CDATA\[([\s\S]*)\]\]>\s*$/.exec(raw);
	// eslint-disable-next-line no-control-regex
	return (cdata ? cdata[1] : unescapeXml(raw)).replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, max);
}

const strictInt = (value: string, max: number) => (/^\d{1,12}$/.test(value) && Number(value) <= max ? Number(value) : null);
const hostOf = (value: string) => value.toLowerCase().replace(/\.$/, "");

/** `policy` must be the configured domain or a subdomain of it. A parent domain is not accepted. */
function owns(hostname: string, policy: string) {
	return policy === hostname || policy.endsWith(`.${hostname}`);
}

export function parseDmarcAggregateXml(source: string, options: { hostname: string; now: Date }): DmarcReport {
	if (/<!DOCTYPE|<!ENTITY/i.test(source)) throw new ReportError("rejected", "DOCTYPE and ENTITY declarations are not accepted");
	const xml = stripComments(source);
	if (countTags(xml, "feedback", 0) === 0) throw new ReportError("rejected", "Not a DMARC aggregate report");
	if (countTags(xml, "record", REPORT_LIMITS.records) > REPORT_LIMITS.records) throw new ReportError("rejected", `More than ${REPORT_LIMITS.records} records`);

	const metadata = readTag(xml, "report_metadata")?.inner ?? "";
	const reporterOrg = text(metadata, "org_name", REPORT_LIMITS.org);
	const reportId = text(metadata, "report_id", REPORT_LIMITS.reportId);
	if (!reporterOrg || !reportId) throw new ReportError("failed", "Missing org_name or report_id");
	const range = readTag(metadata, "date_range")?.inner ?? "";
	const begin = strictInt(text(range, "begin", 20), 4_102_444_800);
	if (begin === null) throw new ReportError("failed", "Missing or invalid date_range");
	const nowSeconds = Math.floor(options.now.getTime() / 1000);
	if (begin > nowSeconds + REPORT_LIMITS.maxFutureSeconds || begin < nowSeconds - REPORT_LIMITS.maxAgeSeconds) throw new ReportError("rejected", "Report date is outside the accepted window");
	const end = strictInt(text(range, "end", 20), 4_102_444_800) ?? begin;
	if (end - begin > REPORT_LIMITS.maxRangeSeconds) throw new ReportError("rejected", "The report date range is longer than 7 days");

	const policy = readTag(xml, "policy_published")?.inner ?? "";
	const policyDomain = hostOf(text(policy, "domain", REPORT_LIMITS.domain));
	if (!policyDomain || !owns(hostOf(options.hostname), policyDomain)) throw new ReportError("rejected", "Domain mismatch");
	const p = text(policy, "p", 16).toLowerCase();
	const policyP = p === "none" || p === "quarantine" || p === "reject" ? p : null;
	const policyPct = strictInt(text(policy, "pct", 5), 100);

	const merged = new Map<string, DmarcRow>();
	let recordCount = 0;
	let messageCount = 0;
	let cursor = 0;
	for (;;) {
		const record = readTag(xml, "record", cursor);
		if (!record) break;
		cursor = record.next;
		recordCount += 1;
		const row = readTag(record.inner, "row")?.inner ?? "";
		const sourceIp = text(row, "source_ip", REPORT_LIMITS.ip).toLowerCase();
		const count = strictInt(text(row, "count", 12), REPORT_LIMITS.maxCount);
		if (!count || reverseName(sourceIp) === null) continue;
		const evaluated = readTag(row, "policy_evaluated")?.inner ?? "";
		const disposition = text(evaluated, "disposition", 16).toLowerCase();
		const headerFrom = hostOf(text(readTag(record.inner, "identifiers")?.inner ?? "", "header_from", REPORT_LIMITS.domain)) || policyDomain;
		const entry: DmarcRow = {
			sourceIp,
			headerFrom,
			disposition: disposition === "quarantine" || disposition === "reject" ? disposition : "none",
			dkimAligned: text(evaluated, "dkim", 16).toLowerCase() === "pass",
			spfAligned: text(evaluated, "spf", 16).toLowerCase() === "pass",
			count,
		};
		messageCount += count;
		const key = `${sourceIp}|${headerFrom}|${entry.disposition}|${entry.dkimAligned}|${entry.spfAligned}`;
		const existing = merged.get(key);
		if (existing) existing.count += count;
		else merged.set(key, entry);
	}
	if (recordCount === 0) throw new ReportError("failed", "The report has no records");

	const sorted = [...merged.values()].sort((a, b) => b.count - a.count);
	return {
		reporterOrg,
		reporterEmail: text(metadata, "email", REPORT_LIMITS.email) || null,
		reportId,
		dateBegin: new Date(begin * 1000),
		dateEnd: new Date(Math.max(end, begin) * 1000),
		day: new Date(begin * 1000).toISOString().slice(0, 10),
		policyDomain,
		policyP,
		policyPct,
		recordCount,
		messageCount,
		rows: sorted.slice(0, REPORT_LIMITS.rows),
		truncated: sorted.length > REPORT_LIMITS.rows,
	};
}

// ---- keys -----------------------------------------------------------------------

async function sha256Hex(parts: string[]): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(parts.join("\0")));
	return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Identifies a report, so the same one arriving twice (or a queue redelivery) conflicts. */
export const reportKey = (reporterOrg: string, reportId: string) => sha256Hex(["dmarc", reporterOrg, reportId]);

/** Identifies one aggregate row within a day, keeping the unique index narrow. */
export const rowKey = (reporterOrg: string, row: Pick<DmarcRow, "sourceIp" | "headerFrom" | "disposition" | "dkimAligned" | "spfAligned">) =>
	sha256Hex([row.sourceIp, reporterOrg, row.headerFrom, row.disposition, String(row.dkimAligned), String(row.spfAligned)]);

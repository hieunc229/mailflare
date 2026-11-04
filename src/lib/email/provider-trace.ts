import type { ProviderVerdicts } from "@/lib/spam/types";
import type { MessageAuthentication, MessageAuthenticationMethod } from "@/lib/email/authentication-types";
import { isSameOrSubdomain } from "@/lib/email/domain-match";
import { extractSenderIp } from "@/lib/spam/domain-utils";

export type ProviderTrace = { verdicts?: ProviderVerdicts; senderIp?: string };

const HEADER_SCAN_BYTES = 64 * 1024;
/** Headers SES prepends when it accepts a message; the trace ends at the first header it did not write. */
const SES_HEADERS = new Set(["return-path", "received", "received-spf", "authentication-results", "x-ses-receipt", "x-ses-dkim-signature", "x-ses-spam-verdict", "x-ses-virus-verdict"]);

function readHeaderLines(raw: ArrayBuffer): { name: string; value: string }[] {
	const text = new TextDecoder().decode(raw.slice(0, Math.min(raw.byteLength, HEADER_SCAN_BYTES)));
	const end = text.search(/\r?\n\r?\n/);
	const block = end === -1 ? text : text.slice(0, end);
	const headers: { name: string; value: string }[] = [];
	for (const line of block.split(/\r?\n/)) {
		if (/^[ \t]/.test(line) && headers.length) headers[headers.length - 1].value += ` ${line.trim()}`;
		else {
			const colon = line.indexOf(":");
			if (colon > 0) headers.push({ name: line.slice(0, colon).trim().toLowerCase(), value: line.slice(colon + 1).trim() });
		}
	}
	return headers;
}

/**
 * The leading run of headers SES wrote, or null when the message did not come
 * through SES. Reading stops at the first header SES did not add, so a sender
 * cannot forge an authentication result further down the message.
 */
function readSesHeaders(raw: ArrayBuffer): { name: string; value: string }[] | null {
	const leading: { name: string; value: string }[] = [];
	for (const header of readHeaderLines(raw)) {
		if (!SES_HEADERS.has(header.name)) break;
		leading.push(header);
	}
	return leading.some((header) => header.name === "x-ses-receipt") ? leading : null;
}

function headerValue(headers: { name: string; value: string }[], name: string): string | undefined {
	return headers.find((header) => header.name === name)?.value;
}

/**
 * The verdicts and connecting IP SES recorded in the headers it prepended (Resend receives through SES too).
 * Without an `X-SES-Receipt` in that leading run nothing is trusted.
 */
export function readSesTrace(raw: ArrayBuffer): ProviderTrace {
	const leading = readSesHeaders(raw);
	if (!leading) return {};
	const verdicts: ProviderVerdicts = {};
	const results = headerValue(leading, "authentication-results");
	if (results && /^amazonses\.com\s*;/i.test(results)) {
		for (const method of ["spf", "dkim", "dmarc"] as const) {
			const value = results.match(new RegExp(`(?:^|[;\\s])${method}=([a-z]+)`, "i"))?.[1];
			if (value) verdicts[method] = value.toUpperCase();
		}
	}
	const spam = headerValue(leading, "x-ses-spam-verdict");
	const virus = headerValue(leading, "x-ses-virus-verdict");
	if (spam) verdicts.spam = spam.toUpperCase();
	if (virus) verdicts.virus = virus.toUpperCase();
	const received = headerValue(leading, "received");
	const senderIp = received ? extractSenderIp({ received }) ?? undefined : undefined;
	return { verdicts: Object.keys(verdicts).length ? verdicts : undefined, senderIp };
}

/** Split an Authentication-Results value on semicolons outside comment parentheses. */
function splitResults(value: string): string[] {
	const sections: string[] = [];
	let current = "";
	let depth = 0;
	for (const char of value) {
		if (char === "(") depth += 1;
		else if (char === ")") depth = Math.max(0, depth - 1);
		if (char === ";" && depth === 0) {
			if (current.trim()) sections.push(current.trim());
			current = "";
			continue;
		}
		current += char;
	}
	if (current.trim()) sections.push(current.trim());
	return sections;
}

function methodSections(sections: string[], method: "spf" | "dkim" | "dmarc"): string[] {
	return sections.filter((section) => new RegExp(`^${method}\\s*=`, "i").test(section));
}

/** Prefer a passing signature when a message carries more than one of the same method. */
function methodSection(sections: string[], method: "spf" | "dkim" | "dmarc"): string | null {
	const matches = methodSections(sections, method);
	return matches.find((section) => new RegExp(`^${method}\\s*=\\s*pass\\b`, "i").test(section)) ?? matches[0] ?? null;
}

function methodStatus(section: string | null, method: "spf" | "dkim" | "dmarc"): string | null {
	return section?.match(new RegExp(`^${method}\\s*=\\s*([a-z]+)`, "i"))?.[1]?.toUpperCase() ?? null;
}

/** A domain from either `d=`/`smtp.mailfrom=` (a domain) or `i=` (a mailbox). */
function domainFromIdentity(value: string | null): string | null {
	if (!value) return null;
	const cleaned = value.replace(/^@/, "").replace(/^<|>$/g, "").trim().toLowerCase();
	const at = cleaned.lastIndexOf("@");
	const domain = at >= 0 ? cleaned.slice(at + 1) : cleaned;
	return domain || null;
}

function tlsVersion(received: string | undefined): string | null {
	const version = received?.match(/\bversion\s*=\s*(TLS(?:v|_)?[\d.]+)/i)?.[1];
	if (!version) return null;
	return version.replace(/^TLSv?/i, "TLS ").replace(/_/g, ".");
}

function senderDomainMatches(fromAddress: string, domains: string[]): boolean | null {
	const fromDomain = fromAddress.slice(fromAddress.lastIndexOf("@") + 1).trim().toLowerCase();
	if (!fromDomain || domains.length === 0) return null;
	return domains.some((domain) => isSameOrSubdomain(domain, fromDomain));
}

/**
 * Authentication results for a message that arrived through SES. Returns null
 * when the message has no trusted provider trace, so callers can say results
 * are unavailable instead of trusting headers the sender could have written.
 */
export function readSesAuthentication(raw: ArrayBuffer, fromAddress: string): MessageAuthentication | null {
	const leading = readSesHeaders(raw);
	if (!leading) return null;
	const results = headerValue(leading, "authentication-results");
	if (!results || !/^amazonses\.com\s*;/i.test(results)) return null;

	const sections = splitResults(results);
	const spfSections = methodSections(sections, "spf");
	const dkimSections = methodSections(sections, "dkim");
	const spfSection = methodSection(sections, "spf");
	const dkimSection = methodSection(sections, "dkim");
	const dmarcSection = methodSection(sections, "dmarc");

	const spfStatus = methodStatus(spfSection, "spf");
	const dkimStatus = methodStatus(dkimSection, "dkim");
	const dmarcStatus = methodStatus(dmarcSection, "dmarc");
	if (!spfStatus && !dkimStatus && !dmarcStatus) return null;

	const spfIp = spfSection?.match(/\bclient-ip\s*=\s*([^\s;)]+)/i)?.[1]
		?? spfSection?.match(/\(sender IP is ([^\s;)]+)\)/i)?.[1]
		?? null;
	const mailedBy = spfSection
		? domainFromIdentity(
			spfSection.match(/\bsmtp\.mailfrom\s*=\s*([^\s;)]+)/i)?.[1]
				?? spfSection.match(/\benvelope-from\s*=\s*([^\s;)]+)/i)?.[1]
				?? null,
		)
		: null;
	const signedBy = dkimSection
		? domainFromIdentity(
			dkimSection.match(/\bheader\.d\s*=\s*([^\s;)]+)/i)?.[1]
				?? dkimSection.match(/\bheader\.i\s*=\s*@?([^\s;)]+)/i)?.[1]
				?? null,
		)
		: null;
	const dmarcDomain = dmarcSection?.match(/\bheader\.from\s*=\s*([^\s;)]+)/i)?.[1]?.toLowerCase() ?? null;
	// Only passing signatures say anything about alignment; a failing one must
	// not make an unrelated sender look aligned.
	const alignedDomains = [...spfSections, ...dkimSections]
		.filter((section) => /^(?:spf|dkim)\s*=\s*pass\b/i.test(section))
		.map((section) => /^spf\s*=/i.test(section)
			? domainFromIdentity(
				section.match(/\bsmtp\.mailfrom\s*=\s*([^\s;)]+)/i)?.[1]
					?? section.match(/\benvelope-from\s*=\s*([^\s;)]+)/i)?.[1]
					?? null,
			)
			: domainFromIdentity(
				section.match(/\bheader\.d\s*=\s*([^\s;)]+)/i)?.[1]
					?? section.match(/\bheader\.i\s*=\s*@?([^\s;)]+)/i)?.[1]
					?? null,
			))
		.filter((domain): domain is string => !!domain);

	const method = (status: string | null, detail: string | null): MessageAuthenticationMethod | null =>
		status ? { status, detail } : null;
	const received = headerValue(leading, "received");
	const senderIp = spfIp ?? (received ? extractSenderIp({ received }) : null);

	return {
		spf: method(spfStatus, spfIp ? `IP ${spfIp}` : mailedBy ? `mailed by ${mailedBy}` : null),
		dkim: method(dkimStatus, signedBy ? `d=${signedBy}` : null),
		dmarc: method(dmarcStatus, dmarcDomain ? `header.from=${dmarcDomain}` : null),
		signedBy,
		mailedBy,
		senderIp,
		encryption: tlsVersion(received),
		aligned: senderDomainMatches(fromAddress, alignedDomains),
	};
}

/** Headers a provider has not vouched for: nothing the sender wrote here may count as authentication. */
const UNTRUSTED_PROVIDER_HEADERS = new Set(["authentication-results", "received-spf", "arc-authentication-results", "received", "return-path", "x-ses-receipt", "x-ses-spam-verdict", "x-ses-virus-verdict", "x-ses-dkim-signature"]);
const MAX_HEADER_ENTRIES = 200;
const MAX_HEADER_VALUE = 2000;

/**
 * A bounded header map (lower-case names, first value wins) for providers that do not hand one over,
 * so auto-reply suppression and spam analysis can see Auto-Submitted, Precedence, List-Id and similar.
 */
export function readHeaderMap(raw: ArrayBuffer): Record<string, string> {
	const map: Record<string, string> = {};
	let count = 0;
	for (const header of readHeaderLines(raw)) {
		if (UNTRUSTED_PROVIDER_HEADERS.has(header.name) || header.name in map) continue;
		map[header.name] = header.value.slice(0, MAX_HEADER_VALUE);
		if (++count >= MAX_HEADER_ENTRIES) break;
	}
	return map;
}

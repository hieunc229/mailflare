import type { ProviderVerdicts } from "@/lib/spam/types";
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
 * The verdicts and connecting IP SES recorded in the headers it prepended (Resend receives through SES too).
 * Only the leading run of SES-written headers is read, and the first of each wins, so anything the sender
 * placed further down cannot pose as SES. Without an `X-SES-Receipt` in that run nothing is trusted.
 */
export function readSesTrace(raw: ArrayBuffer): ProviderTrace {
	const leading: { name: string; value: string }[] = [];
	for (const header of readHeaderLines(raw)) {
		if (!SES_HEADERS.has(header.name)) break;
		leading.push(header);
	}
	if (!leading.some((header) => header.name === "x-ses-receipt")) return {};
	const first = (name: string) => leading.find((header) => header.name === name)?.value;
	const verdicts: ProviderVerdicts = {};
	const results = first("authentication-results");
	if (results && /^amazonses\.com\s*;/i.test(results)) {
		for (const method of ["spf", "dkim", "dmarc"] as const) {
			const value = results.match(new RegExp(`(?:^|[;\\s])${method}=([a-z]+)`, "i"))?.[1];
			if (value) verdicts[method] = value.toUpperCase();
		}
	}
	const spam = first("x-ses-spam-verdict");
	const virus = first("x-ses-virus-verdict");
	if (spam) verdicts.spam = spam.toUpperCase();
	if (virus) verdicts.virus = virus.toUpperCase();
	const received = first("received");
	const senderIp = received ? extractSenderIp({ received }) ?? undefined : undefined;
	return { verdicts: Object.keys(verdicts).length ? verdicts : undefined, senderIp };
}

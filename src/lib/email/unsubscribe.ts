import type { UnsubscribeUrl } from "@/lib/email/unsubscribe-types";

const maxHeaderBytes = 64 * 1024;
const allowedUnsubscribeProtocols = new Set(["http:", "https:", "mailto:"]);

function getHeaderBlock(raw: ArrayBuffer): string {
	const slice = raw.slice(0, Math.min(raw.byteLength, maxHeaderBytes));
	const text = new TextDecoder("utf-8", { fatal: false }).decode(slice);
	const headerEnd = text.search(/\r?\n\r?\n/);
	return headerEnd === -1 ? text : text.slice(0, headerEnd);
}

function parseHeaders(headerBlock: string): Map<string, string[]> {
	const headers = new Map<string, string[]>();
	let currentName: string | null = null;

	for (const line of headerBlock.split(/\r?\n/)) {
		if (/^[\t ]/.test(line) && currentName) {
			const values = headers.get(currentName);
			if (values?.length) values[values.length - 1] += ` ${line.trim()}`;
			continue;
		}

		const separator = line.indexOf(":");
		if (separator <= 0) {
			currentName = null;
			continue;
		}

		currentName = line.slice(0, separator).trim().toLowerCase();
		const value = line.slice(separator + 1).trim();
		headers.set(currentName, [...(headers.get(currentName) ?? []), value]);
	}

	return headers;
}

function normalizeCandidate(value: string): string {
	return value.trim().replace(/^<|>$/g, "").replace(/^"|"$/g, "");
}

function isAllowedUnsubscribeUrl(value: string): boolean {
	try {
		return allowedUnsubscribeProtocols.has(new URL(value).protocol);
	} catch {
		return false;
	}
}

function getCandidates(value: string): string[] {
	const bracketed = [...value.matchAll(/<([^>]+)>/g)].map((match) => normalizeCandidate(match[1] ?? ""));
	const bare = value.split(",").map(normalizeCandidate);
	return [...bracketed, ...bare].filter(Boolean);
}

/** RFC 8058 marks a one-click endpoint with `List-Unsubscribe-Post: List-Unsubscribe=One-Click`. */
function hasOneClickPost(headers: Map<string, string[]>): boolean {
	return (headers.get("list-unsubscribe-post") ?? []).some((value) => /list-unsubscribe\s*=\s*one-click/i.test(value));
}

/**
 * Every header name covered by any `DKIM-Signature` `h=` list, lower-cased.
 * RFC 8058 expects the List-Unsubscribe headers to be signed; when none of the
 * message's signatures covers them, the one-click header could have been added
 * by a relay and is safer treated as an ordinary link. A forged signature can
 * still claim coverage, so this stays a best-effort gate, not a verification.
 */
export function dkimCoveredHeaders(headers: Map<string, string[]>): Set<string> {
	const covered = new Set<string>();
	for (const value of headers.get("dkim-signature") ?? []) {
		const match = /(?:^|;)\s*h\s*=\s*([^;]+)/i.exec(value);
		if (!match) continue;
		for (const name of match[1]!.split(":")) covered.add(name.trim().toLowerCase());
	}
	return covered;
}

export function extractUnsubscribeUrlFromRaw(raw: ArrayBuffer): UnsubscribeUrl {
	const headers = parseHeaders(getHeaderBlock(raw));
	const values = headers.get("list-unsubscribe") ?? [];
	const candidates = values.flatMap(getCandidates).filter(isAllowedUnsubscribeUrl);
	const url = candidates.find((candidate) => candidate.startsWith("https://") || candidate.startsWith("http://"))
		?? candidates.find((candidate) => candidate.startsWith("mailto:"))
		?? null;
	const mailto = candidates.find((candidate) => candidate.startsWith("mailto:")) ?? null;
	if (!url) return null;
	return { url, oneClick: hasOneClickPost(headers), mailto, dkimCoversUnsubscribe: dkimCoveredHeaders(headers).has("list-unsubscribe") };
}

export async function getUnsubscribeUrlFromRawR2Key(env: CloudflareEnv, rawR2Key: string | null): Promise<UnsubscribeUrl> {
	if (!rawR2Key) return null;
	const raw = await env.BUCKET.get(rawR2Key, { range: { offset: 0, length: maxHeaderBytes } });
	if (!raw) return null;
	return extractUnsubscribeUrlFromRaw(await raw.arrayBuffer());
}

const unsubscribeWord = /unsubscribe/i;
const anchorPattern = /<a\b[^>]*?href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a\s*>/gi;
const textUrlPattern = /https?:\/\/[^\s<>"']+/g;

function isHttpUrl(value: string): boolean {
	try {
		const protocol = new URL(value).protocol;
		return protocol === "http:" || protocol === "https:";
	} catch {
		return false;
	}
}

/**
 * The fallback when no List-Unsubscribe header exists: an anchor whose href or
 * label literally says "unsubscribe", or a bare text URL containing the word.
 * Only real http(s) links qualify — never a loose string match on body text.
 */
export function extractUnsubscribeLinkFromBody(htmlBody: string | null, textBody: string | null): string | null {
	if (htmlBody) {
		for (const match of htmlBody.matchAll(anchorPattern)) {
			const href = match[1]?.replace(/&amp;/g, "&").trim();
			if (!href || !isHttpUrl(href)) continue;
			const label = (match[2] ?? "").replace(/<[^>]*>/g, " ");
			if (unsubscribeWord.test(href) || unsubscribeWord.test(label)) return href;
		}
	}
	if (textBody) {
		for (const match of textBody.matchAll(textUrlPattern)) {
			const url = match[0].replace(/[.,;:!?)\]}]+$/, "");
			if (unsubscribeWord.test(url) && isHttpUrl(url)) return url;
		}
	}
	return null;
}

function sanitizeHeaderValue(value: string, max: number): string {
	// A mailto body/subject must never smuggle extra headers into the composed message.
	// eslint-disable-next-line no-control-regex
	return value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

/** Pulls the recipient out of a `mailto:` candidate, honouring its subject/body params for automated processors. */
export function parseMailtoUnsubscribe(url: string): import("@/lib/email/unsubscribe-types").MailtoUnsubscribeTarget | null {
	try {
		const parsed = new URL(url);
		if (parsed.protocol !== "mailto:") return null;
		const to = sanitizeHeaderValue(decodeURIComponent(parsed.pathname).split(",")[0] ?? "", 253);
		if (!to || !to.includes("@")) return null;
		return {
			to,
			subject: sanitizeHeaderValue(parsed.searchParams.get("subject") ?? "", 200) || "unsubscribe",
			text: sanitizeHeaderValue(parsed.searchParams.get("body") ?? "", 1_000) || "unsubscribe",
		};
	} catch {
		return null;
	}
}

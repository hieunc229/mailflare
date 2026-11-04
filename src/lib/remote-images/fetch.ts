import { queryDns } from "@/lib/dns-query";
import { isPublicIpv4 } from "@/lib/spam/domain-utils";

export const REMOTE_IMAGE_MAX_URL_LENGTH = 4096;
export const REMOTE_IMAGE_MAX_BYTES = 5 * 1024 * 1024;
export const REMOTE_IMAGE_MAX_REDIRECTS = 3;
export const REMOTE_IMAGE_TIMEOUT_MS = 10_000;

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const ALLOWED_CONTENT_TYPES = new Set([
	"image/png",
	"image/jpeg",
	"image/gif",
	"image/webp",
	"image/avif",
]);

export type RemoteImageFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export class RemoteImageError extends Error {
	constructor(
		message: string,
		readonly status: number,
		readonly code: string,
	) {
		super(message);
		this.name = "RemoteImageError";
	}
}

export type RemoteImageResult = {
	body: Uint8Array;
	contentType: string;
};

export type RemoteImageFetchOptions = {
	fetch?: RemoteImageFetch;
	/** Resolves a hostname to its A and AAAA addresses; every one must be public. Defaults to DNS-over-HTTPS. */
	resolveHost?: (hostname: string) => Promise<string[]>;
	blockedOrigins?: Iterable<string>;
	timeoutMs?: number;
	maxBytes?: number;
	maxRedirects?: number;
};

function invalidUrl(message = "Invalid remote image URL"): never {
	throw new RemoteImageError(message, 400, "invalid_url");
}

export function isIpLiteral(hostname: string): boolean {
	return hostname.startsWith("[") || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname);
}

// Wildcard DNS services that resolve an embedded address, e.g. 127.0.0.1.nip.io.
const WILDCARD_DNS_SUFFIXES = ["nip.io", "sslip.io", "xip.io", "traefik.me", "localtest.me", "lvh.me", "localhost.run"];

function embedsNonPublicIpv4(host: string): boolean {
	for (const match of host.matchAll(/(?<![\d])(\d{1,3})[.-](\d{1,3})[.-](\d{1,3})[.-](\d{1,3})(?![\d])/g)) {
		if (!isPublicIpv4(`${match[1]}.${match[2]}.${match[3]}.${match[4]}`)) return true;
	}
	return false;
}

export function isForbiddenHostname(hostname: string): boolean {
	const host = hostname.toLowerCase().replace(/\.$/, "");
	if (embedsNonPublicIpv4(host)) return true;
	if (WILDCARD_DNS_SUFFIXES.some((suffix) => host === suffix || host.endsWith(`.${suffix}`))) return true;
	return host === "localhost"
		|| host === "local"
		|| host === "internal"
		|| host === "test"
		|| host.endsWith(".localhost")
		|| host.endsWith(".local")
		|| host.endsWith(".internal")
		|| host === "home.arpa"
		|| host.endsWith(".home.arpa")
		|| host.endsWith(".test");
}

export function parseRemoteImageUrl(value: string, blockedOrigins: Iterable<string> = []): URL {
	if (!value || value.length > REMOTE_IMAGE_MAX_URL_LENGTH) invalidUrl();

	let url: URL;
	try {
		url = new URL(value);
	} catch {
		invalidUrl();
	}

	if (url.protocol !== "http:" && url.protocol !== "https:") invalidUrl();
	if (url.username || url.password || url.port) invalidUrl();
	if (!url.hostname || isIpLiteral(url.hostname) || isForbiddenHostname(url.hostname)) invalidUrl();

	for (const origin of blockedOrigins) {
		if (url.origin === origin) invalidUrl("Remote image URL cannot target this application");
	}

	return url;
}

function contentTypeEssence(value: string | null): string | null {
	if (!value) return null;
	const essence = value.split(";", 1)[0]?.trim().toLowerCase() ?? "";
	return ALLOWED_CONTENT_TYPES.has(essence) ? essence : null;
}

function ascii(bytes: Uint8Array, start: number, length: number): string {
	return String.fromCharCode(...bytes.subarray(start, start + length));
}

function hasAvifSignature(bytes: Uint8Array): boolean {
	if (bytes.length < 16 || ascii(bytes, 4, 4) !== "ftyp") return false;
	const boxSize = Math.min(bytes.length, new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0));
	if (boxSize < 16) return false;
	for (let offset = 8; offset + 4 <= boxSize; offset += 4) {
		const brand = ascii(bytes, offset, 4);
		if (brand === "avif" || brand === "avis") return true;
	}
	return false;
}

function signatureMatches(contentType: string, bytes: Uint8Array): boolean {
	switch (contentType) {
		case "image/png":
			return bytes.length >= 8 && [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((value, index) => bytes[index] === value);
		case "image/jpeg":
			return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
		case "image/gif":
			return bytes.length >= 6 && (ascii(bytes, 0, 6) === "GIF87a" || ascii(bytes, 0, 6) === "GIF89a");
		case "image/webp":
			return bytes.length >= 12 && ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP";
		case "image/avif":
			return hasAvifSignature(bytes);
		default:
			return false;
	}
}

async function readLimitedBody(response: Response, maxBytes: number): Promise<Uint8Array> {
	const declaredLength = Number(response.headers.get("content-length"));
	if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
		await response.body?.cancel().catch(() => undefined);
		throw new RemoteImageError("Remote image is too large", 413, "too_large");
	}
	if (!response.body) throw new RemoteImageError("Remote image has no body", 502, "empty_body");

	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			size += value.byteLength;
			if (size > maxBytes) {
				await reader.cancel().catch(() => undefined);
				throw new RemoteImageError("Remote image is too large", 413, "too_large");
			}
			chunks.push(value);
		}
	} catch (error) {
		await reader.cancel().catch(() => undefined);
		throw error;
	}

	const body = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) {
		body.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return body;
}

export function isPublicAddress(address: string): boolean {
	const value = address.trim().toLowerCase();
	if (!value.includes(":")) return isPublicIpv4(value);
	const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(value);
	if (mapped) return isPublicIpv4(mapped[1]);
	if (value === "::" || value === "::1") return false;
	// Unique local (fc00::/7), link-local (fe80::/10) and multicast (ff00::/8).
	return !/^(f[cd]|fe[89ab]|ff)/.test(value);
}

async function defaultResolveHost(hostname: string): Promise<string[]> {
	const [v4, v6] = await Promise.all([queryDns(hostname, "A"), queryDns(hostname, "AAAA")]);
	return [...v4, ...v6];
}

/** A public-looking name can still resolve to a private address, so check what it resolves to. */
async function assertPublicHost(resolve: (hostname: string) => Promise<string[]>, hostname: string): Promise<void> {
	let addresses: string[];
	try {
		addresses = await resolve(hostname);
	} catch {
		throw new RemoteImageError("Could not verify remote image host", 502, "upstream_error");
	}
	if (!addresses.length || addresses.some((address) => !isPublicAddress(address))) invalidUrl("Remote image host is not public");
}

export async function fetchRemoteImage(value: string, options: RemoteImageFetchOptions = {}): Promise<RemoteImageResult> {
	const fetchImpl = options.fetch ?? fetch;
	const blockedOrigins = [...(options.blockedOrigins ?? [])];
	const maxBytes = options.maxBytes ?? REMOTE_IMAGE_MAX_BYTES;
	const maxRedirects = options.maxRedirects ?? REMOTE_IMAGE_MAX_REDIRECTS;
	const resolveHost = options.resolveHost ?? defaultResolveHost;
	let current = parseRemoteImageUrl(value, blockedOrigins);
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? REMOTE_IMAGE_TIMEOUT_MS);

	try {
		for (let redirects = 0; ; redirects += 1) {
			await assertPublicHost(resolveHost, current.hostname);
			let response: Response;
			try {
				response = await fetchImpl(current.href, {
					method: "GET",
					headers: { Accept: "image/png,image/jpeg,image/gif,image/webp,image/avif", "User-Agent": "Mailflare-Remote-Images/1.0" },
					cache: "no-store",
					redirect: "manual",
					signal: controller.signal,
				});
			} catch {
				if (controller.signal.aborted) throw new RemoteImageError("Remote image request timed out", 504, "timeout");
				throw new RemoteImageError("Could not fetch remote image", 502, "upstream_error");
			}

			if (REDIRECT_STATUSES.has(response.status)) {
				await response.body?.cancel().catch(() => undefined);
				if (redirects >= maxRedirects) throw new RemoteImageError("Too many remote image redirects", 502, "too_many_redirects");
				const location = response.headers.get("location");
				if (!location) throw new RemoteImageError("Remote image redirect has no location", 502, "invalid_redirect");
				let redirected: URL;
				try {
					redirected = new URL(location, current);
				} catch {
					throw new RemoteImageError("Remote image redirect is invalid", 502, "invalid_redirect");
				}
				current = parseRemoteImageUrl(redirected.href, blockedOrigins);
				continue;
			}

			if (!response.ok) {
				await response.body?.cancel().catch(() => undefined);
				throw new RemoteImageError("Remote image server returned an error", 502, "upstream_status");
			}
			const contentType = contentTypeEssence(response.headers.get("content-type"));
			if (!contentType) {
				await response.body?.cancel().catch(() => undefined);
				const receivedType = (response.headers.get("content-type") ?? "missing content type").split(";", 1)[0].slice(0, 100);
				throw new RemoteImageError(`Remote resource is not a supported image (${receivedType})`, 415, "unsupported_type");
			}
			let body: Uint8Array;
			try {
				body = await readLimitedBody(response, maxBytes);
			} catch (error) {
				if (controller.signal.aborted && !(error instanceof RemoteImageError)) {
					throw new RemoteImageError("Remote image request timed out", 504, "timeout");
				}
				throw error;
			}
			if (!signatureMatches(contentType, body)) throw new RemoteImageError("Remote image signature is invalid", 415, "invalid_signature");
			return { body, contentType };
		}
	} finally {
		clearTimeout(timeout);
	}
}

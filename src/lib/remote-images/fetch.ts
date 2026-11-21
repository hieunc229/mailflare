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

/** Parses any textual IPv6 form (compressed, mixed dotted tail, zone id) into 8 groups, or null if malformed. */
function parseIpv6(input: string): number[] | null {
	let value = input.split("%", 1)[0];
	const tail = /(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(value);
	if (tail) {
		const octets = tail.slice(1).map(Number);
		if (octets.some((octet) => octet > 255)) return null;
		value = `${value.slice(0, tail.index)}${((octets[0] << 8) | octets[1]).toString(16)}:${((octets[2] << 8) | octets[3]).toString(16)}`;
	}
	const halves = value.split("::");
	if (halves.length > 2) return null;
	const toGroups = (part: string) => (part === "" ? [] : part.split(":"));
	const head = toGroups(halves[0]);
	const rest = halves.length === 2 ? toGroups(halves[1]) : [];
	const missing = 8 - head.length - rest.length;
	if (halves.length === 2 ? missing < 1 : missing !== 0) return null;
	const groups = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill("0"), ...rest];
	if (groups.length !== 8 || groups.some((group) => !/^[0-9a-f]{1,4}$/.test(group))) return null;
	return groups.map((group) => parseInt(group, 16));
}

const ipv4Of = (high: number, low: number) => `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;

export function isPublicAddress(address: string): boolean {
	const value = address.trim().toLowerCase();
	if (!value.includes(":")) return isPublicIpv4(value);
	const g = parseIpv6(value);
	if (!g) return false;
	const leadingZeros = (count: number) => g.slice(0, count).every((group) => group === 0);
	// IPv4-mapped (::ffff:0:0/96) and IPv4-compatible (::/96, which also covers :: and ::1) take the embedded IPv4's verdict.
	if (leadingZeros(5) && g[5] === 0xffff) return isPublicIpv4(ipv4Of(g[6], g[7]));
	if (leadingZeros(6)) return isPublicIpv4(ipv4Of(g[6], g[7]));
	// NAT64 (64:ff9b::/96) and 6to4 (2002::/16) carry an IPv4 address; local-use NAT64 (64:ff9b:1::/48) is never public.
	if (g[0] === 0x64 && g[1] === 0xff9b) return g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0 && isPublicIpv4(ipv4Of(g[6], g[7]));
	if (g[0] === 0x2002) return isPublicIpv4(ipv4Of(g[1], g[2]));
	// Any other address starting 0000::/8 is reserved.
	if (g[0] >> 8 === 0) return false;
	// Unique local (fc00::/7), link-local and deprecated site-local (fe80::/10, fec0::/10) and multicast (ff00::/8).
	const first = g[0] >> 8;
	return !(first === 0xfc || first === 0xfd || first === 0xfe || first === 0xff);
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

import type { OpenClassification, OpenRequestInfo } from "./types";

/** Transparent 1x1 GIF. */
export const TRACKING_PIXEL_GIF = Uint8Array.from(atob("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"), (char) => char.charCodeAt(0));

export const TRACKING_PIXEL_HEADERS = {
	"Content-Type": "image/gif",
	"Cache-Control": "no-store, no-cache, must-revalidate, private, max-age=0",
	Pragma: "no-cache",
	Expires: "0",
	"Referrer-Policy": "no-referrer",
	"X-Content-Type-Options": "nosniff",
};

/** Scanners and Apple's prefetch fetch images within seconds of delivery; a person rarely does. */
export const AUTOMATED_OPEN_WINDOW_MS = 10_000;
/** Repeat fetches by the same client inside this window count as one open. */
export const DUPLICATE_OPEN_WINDOW_MS = 30_000;
/** Opens beyond this per message still update the counters but are not stored individually. */
export const MAX_STORED_OPENS = 50;

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{20,64}$/;
/** Apple Inc. networks; Mail Privacy Protection fetches every image through them on delivery. */
const APPLE_ASNS = new Set([714, 6185]);

export function createTrackingToken(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(18));
	return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

/** Accepts `<token>` or `<token>.gif` from the pixel URL. */
export function parseTrackingToken(segment: string): string | null {
	const token = segment.endsWith(".gif") ? segment.slice(0, -4) : segment;
	return TOKEN_PATTERN.test(token) ? token : null;
}

export function buildTrackingPixelUrl(origin: string, token: string): string {
	return `${origin.replace(/\/+$/, "")}/api/i/${token}.gif`;
}

/** Picks the public origin for pixel URLs, or null when only a non-HTTP origin is known. */
export function resolveTrackingOrigin(appUrl: string | undefined, publicOrigin: string | undefined): string | null {
	for (const candidate of [appUrl?.trim(), publicOrigin?.trim()]) {
		if (!candidate) continue;
		try {
			const url = new URL(candidate);
			if (url.protocol === "https:" || url.protocol === "http:") return url.origin;
		} catch {
			// Try the next candidate.
		}
	}
	return null;
}

const HOSTNAME_LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;

/**
 * Normalises a domain's pixel hostname. It must be the domain itself or one of
 * its subdomains, so the pixel never names a host the sender does not own.
 */
export function normalizeTrackingHost(input: string, domainHostname: string): { hostname: string } | { error: "invalid" | "outsideDomain" } {
	const hostname = input.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/\.$/, "");
	const domain = domainHostname.trim().toLowerCase();
	if (!hostname || hostname.length > 253 || !hostname.split(".").every((label) => HOSTNAME_LABEL.test(label))) return { error: "invalid" };
	if (hostname !== domain && !hostname.endsWith(`.${domain}`)) return { error: "outsideDomain" };
	return { hostname };
}

/** Appends the pixel inside `<body>` when there is one, otherwise at the end. */
export function injectTrackingPixel(html: string, pixelUrl: string): string {
	const escaped = pixelUrl.replaceAll("&", "&amp;").replaceAll("\"", "&quot;");
	const img = `<img src="${escaped}" width="1" height="1" alt="" style="display:block;width:1px;height:1px;border:0;margin:0;padding:0;opacity:0" />`;
	const bodyClose = html.search(/<\/body\s*>/i);
	return bodyClose === -1 ? `${html}${img}` : `${html.slice(0, bodyClose)}${img}${html.slice(bodyClose)}`;
}

function detectDevice(userAgent: string): string | null {
	if (/iPhone/i.test(userAgent)) return "iPhone";
	if (/iPad/i.test(userAgent)) return "iPad";
	if (/Android/i.test(userAgent)) return "Android";
	if (/Macintosh|Mac OS X/i.test(userAgent)) return "Mac";
	if (/Windows/i.test(userAgent)) return "Windows";
	if (/CrOS/i.test(userAgent)) return "ChromeOS";
	if (/Linux/i.test(userAgent)) return "Linux";
	return null;
}

function detectClient(userAgent: string): { client: string | null; proxied: boolean } {
	if (/GoogleImageProxy|ggpht\.com/i.test(userAgent)) return { client: "Gmail", proxied: true };
	if (/YahooMailProxy/i.test(userAgent)) return { client: "Yahoo Mail", proxied: true };
	if (/Mailflare-Remote-Images/i.test(userAgent)) return { client: "Mailflare", proxied: true };
	if (/Outlook-iOS|Outlook-Android|Microsoft Outlook|MSOffice|ms-office|Microsoft Office/i.test(userAgent)) return { client: "Outlook", proxied: false };
	if (/Thunderbird/i.test(userAgent)) return { client: "Thunderbird", proxied: false };
	if (/AppleWebKit/i.test(userAgent) && !/Chrome|CriOS|Safari\//i.test(userAgent) && /iPhone|iPad|Macintosh/i.test(userAgent)) {
		return { client: "Apple Mail", proxied: false };
	}
	return { client: null, proxied: false };
}

/**
 * Names the client behind a pixel fetch and flags fetches no person caused.
 * Proxied fetches (Gmail, Yahoo, Apple) reveal neither device nor location.
 */
export function classifyOpen(info: OpenRequestInfo): OpenClassification {
	const userAgent = info.userAgent ?? "";
	const appleProxy = (info.asn !== undefined && APPLE_ASNS.has(info.asn)) || userAgent.trim() === "Mozilla/5.0";
	if (appleProxy) return { client: "Apple Mail", device: null, country: null, city: null, automated: true };
	const { client, proxied } = detectClient(userAgent);
	const automated = info.openedAt.getTime() - info.sentAt.getTime() < AUTOMATED_OPEN_WINDOW_MS;
	// Cloudflare reports XX for unknown and T1 for Tor.
	const country = info.country && /^[A-Z]{2}$/.test(info.country) && info.country !== "XX" && info.country !== "T1" ? info.country : null;
	return {
		client,
		device: proxied ? null : detectDevice(userAgent),
		country: proxied ? null : country,
		city: proxied ? null : info.city ?? null,
		automated,
	};
}

export function isDuplicateOpen(
	previous: { openedAt: Date; client: string | null; device: string | null } | undefined,
	next: { openedAt: Date; client: string | null; device: string | null },
): boolean {
	if (!previous) return false;
	return previous.client === next.client && previous.device === next.device &&
		next.openedAt.getTime() - previous.openedAt.getTime() < DUPLICATE_OPEN_WINDOW_MS;
}

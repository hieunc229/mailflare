/**
 * Resolve the real client IP for rate limiting and audit metadata.
 *
 * Forwarded headers are only meaningful when someone trustworthy set them:
 * the self-host server resolves the IP at the socket (or the proxy hop it
 * appended under TRUST_PROXY), stamps it into x-mailflare-client-ip, and
 * strips every client-supplied forwarding header before app code runs. On
 * Workers, cf-connecting-ip is platform-set and cannot be forged. A bare
 * x-forwarded-for is the last resort for other runtimes — its rightmost
 * hop is the least attacker-controlled entry.
 */
export function getClientIp(request: Request): string | null {
	// On Vercel only the headers the platform overwrites count: nothing strips a client-sent cf-connecting-ip
	// there, and trusting it would let a caller pick its own rate-limit bucket.
	if (process.env.MAILFLARE_RUNTIME === "vercel") {
		return (
			headerValue(request, "x-vercel-forwarded-for")?.split(",")[0]?.trim() ||
			headerValue(request, "x-real-ip") ||
			headerValue(request, "x-forwarded-for")?.split(",")[0]?.trim() ||
			null
		);
	}
	return (
		// cf-connecting-ip first: on Workers it is platform-set and unforgeable,
		// and checking it before x-mailflare-client-ip keeps a client-injected
		// copy of the private header from winning there. The self-host server
		// deletes cf-connecting-ip outright, so the stamped value is used next.
		headerValue(request, "cf-connecting-ip") ||
		headerValue(request, "x-mailflare-client-ip") ||
		headerValue(request, "x-forwarded-for")?.split(",").at(-1)?.trim() ||
		null
	);
}

function headerValue(request: Request, name: string): string | null {
	return request.headers.get(name)?.trim() || null;
}

import { getNodeEnv } from "@/lib/runtime";

/**
 * The origin browsers use to reach this app, which a same-origin request must carry.
 *
 * On Workers `request.url` is the public URL. On the self-hosted Node server Next builds it from the
 * bind address (`http://0.0.0.0:3000`), so the expected origin is APP_URL when set, otherwise the
 * Host header, with https only when a trusted reverse proxy (TRUST_PROXY) says so, exactly as the
 * realtime upgrade check does (server/runtime/realtime-origin.ts).
 */
export function expectedRequestOrigin(request: Request): string {
	const env = getNodeEnv();
	const url = new URL(request.url);
	if (env?.MAILFLARE_RUNTIME !== "node") return url.origin;
	const appUrl = env.APP_URL?.trim();
	if (appUrl) {
		try {
			return new URL(appUrl).origin;
		} catch {
			// A malformed APP_URL falls back to the request, so the check still compares something real.
		}
	}
	const host = request.headers.get("host")?.trim();
	const trustProxy = ["1", "true", "yes"].includes((env.TRUST_PROXY ?? "").toLowerCase());
	const forwardedProto = trustProxy ? request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim() : undefined;
	const protocol = forwardedProto === "https" ? "https:" : url.protocol;
	try {
		return host ? new URL(`${protocol}//${host}`).origin : url.origin;
	} catch {
		return url.origin;
	}
}

/**
 * Strict same-origin test for a state-changing browser request that authenticates by cookie.
 * The request must prove it comes from this app's own pages: `Sec-Fetch-Site: same-origin`, or an
 * `Origin` equal to the expected origin. A missing Origin is not accepted on its own (a form post
 * from a sibling subdomain or an old client may omit it), and `same-site` never is.
 */
export function isSameOriginRequest(request: Request, expectedOrigin: string = expectedRequestOrigin(request)): boolean {
	const fetchSite = request.headers.get("Sec-Fetch-Site");
	if (fetchSite === "same-origin") return true;
	if (fetchSite === "cross-site" || fetchSite === "same-site") return false;
	const origin = request.headers.get("Origin");
	return origin !== null && origin === expectedOrigin;
}

/** Call only after session authentication. Bearer tokens are not sent automatically by browsers. */
export function hasValidSessionMutationOrigin(request: Request, expectedOrigin?: string): boolean {
	if (request.headers.get("Authorization")?.startsWith("Bearer ")) return true;
	return isSameOriginRequest(request, expectedOrigin);
}

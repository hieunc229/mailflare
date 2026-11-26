const REWRITTEN = "/api/internal/dav";

/**
 * The path a DAV client asked for. Next hands a rewritten request over under either the original URL or the
 * rewrite's destination, which carries the original in `__dav` (next.config.ts).
 */
export function davRequestTarget(url: string): string {
	if (!url.startsWith(REWRITTEN)) return url;
	const original = new URL(url, "http://localhost").searchParams.get("__dav");
	return original ? original.split("/").map(encodeURIComponent).join("/") : url;
}

/**
 * Request header budget for the self-hosted HTTP server. The Cloudflare email relay sends
 * the whole header map of a message in one X-Mailflare-Headers request header, and a Gmail
 * message with Cloudflare's ARC and Authentication-Results headers on top passes Node's
 * default 16 KiB, which Node answers with 431 before any route runs. 64 KiB leaves room for
 * long header chains; MAX_HTTP_HEADER_SIZE (bytes) overrides it.
 */
export const DEFAULT_MAX_HTTP_HEADER_SIZE = 64 * 1024;

export function resolveMaxHeaderSize(value: string | undefined): number {
	const size = Number(value);
	return Number.isInteger(size) && size >= 16 * 1024 ? size : DEFAULT_MAX_HTTP_HEADER_SIZE;
}

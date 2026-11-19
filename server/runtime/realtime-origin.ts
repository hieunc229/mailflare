import type { IncomingHttpHeaders } from "node:http";
import { hasValidSessionMutationOrigin } from "@/lib/auth/origin";

/**
 * The Worker refuses realtime upgrades whose Origin is not the app's own (worker.ts); the Node server
 * must too, since the SameSite=Lax session cookie still rides a same-site, cross-origin handshake.
 * The expected origin is APP_URL when set, otherwise the Host header (https when a trusted proxy says so).
 */
export function isRealtimeOriginAllowed(headers: IncomingHttpHeaders, options: { appUrl?: string; trustProxy: boolean }): boolean {
	const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value);
	const forwardedProto = options.trustProxy ? first(headers["x-forwarded-proto"])?.split(",")[0]?.trim() : undefined;
	let base: string;
	try {
		base = options.appUrl ? new URL(options.appUrl).origin : `${forwardedProto === "https" ? "https" : "http"}://${first(headers.host) ?? "localhost"}`;
		new URL(base);
	} catch {
		return false;
	}
	const forwarded = new Headers();
	for (const name of ["origin", "sec-fetch-site", "authorization"]) {
		const value = first(headers[name]);
		if (value) forwarded.set(name, value);
	}
	return hasValidSessionMutationOrigin(new Request(`${base}/api/realtime`, { headers: forwarded }), new URL(base).origin);
}

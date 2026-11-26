import { and, eq, inArray, like, or } from "drizzle-orm";
import { getDb } from "@/db";
import { apiKeys } from "@/db/schema";
import { isApiKeyVerificationCached } from "@/lib/api/find-api-key";
import { authenticateApiKeyValue } from "@/lib/api/key-auth";
import type { ApiAuthResult } from "@/lib/api/key-auth-types";
import type { AppPasswordScope } from "@/lib/api/scopes";
import { apiKeyLookupPrefix } from "@/lib/api-keys";
import { isListedAsAppPassword } from "@/lib/auth/app-password-utils";
import { getClientIp } from "@/lib/auth/client-ip";
import { isDavEnabled } from "@/lib/dav/settings";
import { isNodeRuntime, isVercelRuntime } from "@/lib/runtime";

export type AppPasswordProtocol = "jmap" | "caldav" | "carddav" | "imap" | "submission";
export type AppPasswordCheck = { secret: string; protocol: AppPasswordProtocol; clientIp: string | null };

/** The stored scope that lets a key speak each protocol (`dav` covers CalDAV and CardDAV). */
const PROTOCOL_SCOPE: Record<AppPasswordProtocol, AppPasswordScope> = {
	jmap: "jmap",
	caldav: "dav",
	carddav: "dav",
	imap: "imap",
	submission: "submission",
};

/**
 * The scopes a new app password may carry on this server: JMAP always, and
 * `dav` (CalDAV and CardDAV) while an administrator has turned it on. IMAP and
 * SMTP submission are added when their servers ship, so nobody can mint a
 * credential nothing accepts.
 */
export async function availableAppPasswordProtocols(env: CloudflareEnv): Promise<AppPasswordScope[]> {
	return (await isDavEnabled(env)) ? ["jmap", "dav"] : ["jmap"];
}

/**
 * Check an app password for one protocol. Null on any failure, and never says
 * why. Only `kind = 'app'` keys count, and only when they carry the protocol's
 * scope, so older JMAP keys, device keys and API keys cannot be used here.
 * Spaces and dashes are dropped first because the password is shown in groups.
 * The account password is never accepted.
 */
export async function authenticateAppPassword(env: CloudflareEnv, check: AppPasswordCheck): Promise<ApiAuthResult | null> {
	const secret = check.secret.replace(/[\s-]/g, "");
	if (!secret) return null;
	return authenticateApiKeyValue(env, secret, {
		kind: "app",
		scope: PROTOCOL_SCOPE[check.protocol],
		usage: { protocol: check.protocol, ip: check.clientIp },
	});
}

function isLoopback(ip: string | null): boolean {
	return !!ip && (ip === "::1" || ip.startsWith("127.") || ip.startsWith("::ffff:127."));
}

/**
 * Whether a request reached us over TLS. Workers see the real scheme. The Node
 * server only speaks HTTP, so it counts a TLS-terminating proxy it was told to
 * trust (`TRUST_PROXY`, last `x-forwarded-proto` hop) or local development: a
 * loopback client talking to a loopback Host. The Host check matters because a
 * reverse proxy on the same machine (without `TRUST_PROXY`) also connects from
 * loopback but carries the public Host. `x-mailflare-client-ip` is stamped by the Node server
 * and is not trustworthy on Workers, which is why it is only read there.
 */
export function isSecureAppPasswordTransport(env: Pick<CloudflareEnv, "MAILFLARE_RUNTIME">, request: Request): boolean {
	// Vercel terminates TLS and overwrites x-forwarded-proto.
	if (isVercelRuntime(env)) return request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim().toLowerCase() === "https";
	if (!isNodeRuntime(env)) return new URL(request.url).protocol === "https:";
	const trustProxy = ["1", "true", "yes"].includes((process.env.TRUST_PROXY ?? "").toLowerCase());
	const hop = request.headers.get("x-forwarded-proto")?.split(",").at(-1)?.trim().toLowerCase();
	if (trustProxy && hop === "https") return true;
	return isLoopback(getClientIp(request)) && isLoopbackHost(request.headers.get("host") ?? new URL(request.url).host);
}

function isLoopbackHost(host: string): boolean {
	const name = host.trim().toLowerCase().replace(/:\d+$/, "");
	return name === "localhost" || name === "127.0.0.1" || name === "[::1]";
}

/** The password half of a Basic header, or null for anything else. Bearer is not accepted. */
export function basicPassword(request: Request): string | null {
	const header = request.headers.get("Authorization") ?? "";
	if (!/^basic\s/i.test(header)) return null;
	let decoded: string;
	try {
		decoded = new TextDecoder().decode(Uint8Array.from(atob(header.slice(6).trim()), (char) => char.charCodeAt(0)));
	} catch {
		return null;
	}
	const separator = decoded.indexOf(":");
	// The username is ignored; the password identifies the account.
	return separator < 0 ? null : decoded.slice(separator + 1);
}

/** An IPv4 address, or the first 64 bits of an IPv6 one, so a client cannot dodge the limit by rotating addresses in its /64. */
function ipBucket(ip: string): string {
	const text = ip.trim().replace(/^\[|\]$/g, "").replace(/%.*$/, "").toLowerCase();
	const mapped = text.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
	if (mapped) return mapped[1];
	if (!text.includes(":")) return text;
	const [head, tail = ""] = text.split("::");
	const left = head ? head.split(":") : [];
	const right = tail ? tail.split(":") : [];
	const groups = text.includes("::") ? [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill("0"), ...right] : left;
	return groups.slice(0, 4).map((group) => (Number.parseInt(group || "0", 16) || 0).toString(16)).join(":") + "::/64";
}

/**
 * The limiter bucket for one guess. By client IP when there is one. Without an
 * IP (no trusted proxy header) everyone must not share a bucket, so it falls
 * back to the key being guessed: its stored lookup prefix is the front of the
 * secret, which every guess at that key shares.
 */
export function appPasswordGuessKey(ip: string | null, secret: string): string {
	return ip ? `app-auth:ip:${ipBucket(ip)}` : `app-auth:key:${apiKeyLookupPrefix(secret)}`;
}

/**
 * Spend one guess from the budget unless this isolate verified the secret
 * recently (a working client hits the cache and never spends). False when the
 * budget is spent. A limiter that is missing or throws lets the request through.
 */
export async function allowAppPasswordGuess(env: CloudflareEnv, request: Request, password: string, kind?: "app"): Promise<boolean> {
	if (await isApiKeyVerificationCached(password, kind)) return true;
	const limiter = env.DEVICE_LOGIN_RATE_LIMIT ?? env.LOGIN_RATE_LIMIT;
	if (!limiter) return true;
	try {
		return (await limiter.limit({ key: appPasswordGuessKey(getClientIp(request), password) })).success;
	} catch (error) {
		console.warn("App password rate limiter unavailable", error);
		return true;
	}
}

/**
 * HTTP Basic check for the protocols that run over HTTP. Credentials sent over
 * plain HTTP are refused before any lookup (`"insecure"`). A password this
 * isolate has not verified recently is a guess, so it spends the per-IP budget
 * first (`"throttled"` when spent); a working client hits the cache and does not.
 */
export async function authenticateAppPasswordRequest(
	env: CloudflareEnv,
	request: Request,
	protocol: "caldav" | "carddav",
): Promise<ApiAuthResult | "insecure" | "throttled" | null> {
	if (!isSecureAppPasswordTransport(env, request)) {
		console.warn("App password refused: the request did not arrive over HTTPS");
		return "insecure";
	}
	const secret = basicPassword(request)?.replace(/[\s-]/g, "");
	if (!secret) return null;
	if (!(await allowAppPasswordGuess(env, request, secret, "app"))) return "throttled";
	return authenticateAppPassword(env, { secret, protocol, clientIp: getClientIp(request) });
}

/**
 * Delete the credentials that skip the sign-in checks: app passwords, and the
 * older JMAP-only keys (`legacy` keys whose scopes are exactly `["jmap"]`, the
 * same rule as `isListedAsAppPassword`). Older keys that mix `jmap` with other
 * scopes are general API keys and stay. `deleteUserSessions` calls this next to
 * the device-key revocation, so a password change, reset or MFA change
 * disconnects mail apps too.
 */
export async function revokeAllAppPasswords(env: CloudflareEnv, userId: string): Promise<void> {
	const db = getDb(env);
	// Scopes are a JSON string array: the quoted name narrows the rows, `isListedAsAppPassword` decides.
	const candidates = await db
		.select({ id: apiKeys.id, kind: apiKeys.kind, scopes: apiKeys.scopes })
		.from(apiKeys)
		.where(and(eq(apiKeys.userId, userId), or(eq(apiKeys.kind, "app"), and(eq(apiKeys.kind, "legacy"), like(apiKeys.scopes, '%"jmap"%')))));
	const ids = candidates.filter(isListedAsAppPassword).map((key) => key.id);
	if (ids.length) await db.delete(apiKeys).where(and(eq(apiKeys.userId, userId), inArray(apiKeys.id, ids)));
}

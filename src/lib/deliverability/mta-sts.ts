/**
 * MTA-STS (RFC 8461) policy text and the host guard. Pure and framework free so the Worker, the Node server and the
 * Next route share it. Nothing here reads the request beyond the host name and path.
 */
export const MTA_STS_LIMITS = Object.freeze({
	/** One day to one year, in seconds. RFC 8461 allows up to 31,557,600. */
	minMaxAge: 86_400,
	maxMaxAge: 31_557_600,
	defaultMaxAge: 604_800,
	maxMx: 20,
});

export const MTA_STS_HOST_PREFIX = "mta-sts.";
export const MTA_STS_POLICY_PATH = "/.well-known/mta-sts.txt";
export type MtaStsMode = "none" | "testing" | "enforce";

const LABEL = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";
const HOSTNAME = new RegExp(`^${LABEL}(?:\\.${LABEL})*$`);
const MX_PATTERN = new RegExp(`^(?:\\*\\.)?${LABEL}(?:\\.${LABEL})+$`);

/** The managed domain a request host asks about (`mta-sts.<domain>`), or null for any other host or a malformed one. */
export function mtaStsHostDomain(hostname: string): string | null {
	const host = hostname.toLowerCase().replace(/\.$/, "");
	if (!host.startsWith(MTA_STS_HOST_PREFIX) || host.length > 253) return null;
	const domain = host.slice(MTA_STS_HOST_PREFIX.length);
	return HOSTNAME.test(domain) ? domain : null;
}

/** A host name or Host header value without port: `Example.COM:8080` becomes `example.com`. */
export function hostnameOf(hostHeader: string): string {
	return hostHeader.trim().toLowerCase().replace(/:\d+$/, "").replace(/\.$/, "");
}

/** True for any `mta-sts.*` host name, valid or not: such a host never gets the application. */
export const isMtaStsHost = (hostname: string) => hostname.toLowerCase().replace(/\.$/, "").startsWith(MTA_STS_HOST_PREFIX);

const text = (body: string, status: number, headers: Record<string, string> = {}) => new Response(body, { status, headers: { "Content-Type": "text/plain; charset=utf-8", ...headers } });

/**
 * Keeps the full application off `mta-sts.*` hosts: on such a host only GET and HEAD of the policy path continue (to the
 * route, which answers for configured domains only); any other path is a 404 and any other method a 405. Returns null when
 * the request should continue. A Workers Custom Domain or a reverse proxy routes the whole host to the app, so without this
 * the login page and the APIs would be served there too.
 */
export function guardMtaStsHost(request: { hostname: string; pathname: string; method: string }): Response | null {
	if (!isMtaStsHost(request.hostname)) return null;
	if (request.pathname !== MTA_STS_POLICY_PATH) return text("Not found", 404);
	if (request.method !== "GET" && request.method !== "HEAD") return text("Method not allowed", 405, { Allow: "GET, HEAD" });
	return null;
}

/** Lower-cased, de-duplicated, sorted MX host patterns, or null when any entry is not a plain host name (a leading `*.` is allowed). */
export function normalizeMx(hosts: unknown): string[] | null {
	if (!Array.isArray(hosts)) return null;
	const clean = new Set<string>();
	for (const host of hosts) {
		const value = typeof host === "string" ? host.trim().toLowerCase().replace(/\.$/, "") : "";
		if (value.length > 253 || !MX_PATTERN.test(value)) return null;
		clean.add(value);
	}
	return [...clean].sort();
}

/** The value when it is a whole number of seconds inside the allowed range, the default when undefined, otherwise null. */
export function parseMaxAge(value: unknown): number | null {
	if (value === undefined) return MTA_STS_LIMITS.defaultMaxAge;
	return typeof value === "number" && Number.isInteger(value) && value >= MTA_STS_LIMITS.minMaxAge && value <= MTA_STS_LIMITS.maxMaxAge ? value : null;
}

/** The policy file: CRLF lines, MX hosts sorted. Throws on anything that is not a valid mode, MX list or max_age, so a bad value can never reach the file. */
export function buildMtaStsPolicy(policy: { mode: string; mx: string[]; maxAge: number }): string {
	if (policy.mode !== "none" && policy.mode !== "testing" && policy.mode !== "enforce") throw new Error("Invalid MTA-STS mode");
	const mx = normalizeMx(policy.mx);
	if (!mx || mx.length === 0 || mx.length > MTA_STS_LIMITS.maxMx) throw new Error(`Invalid MTA-STS mx list (1 to ${MTA_STS_LIMITS.maxMx} host names)`);
	if (parseMaxAge(policy.maxAge) === null) throw new Error("Invalid MTA-STS max_age");
	return [`version: STSv1`, `mode: ${policy.mode}`, ...mx.map((host) => `mx: ${host}`), `max_age: ${policy.maxAge}`, ""].join("\r\n");
}

const pad = (value: number, width = 2) => String(value).padStart(width, "0");

/**
 * The `id` of the `_mta-sts` TXT record: the UTC time as YYYYMMDDHHMMSS, and always greater than `previous`, so a change
 * made in the same second (or after the clock moved back) still gets a new id and receivers fetch the policy again.
 */
export function nextPolicyId(now: Date, previous: string | null): string {
	const stamp = `${pad(now.getUTCFullYear(), 4)}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}`;
	if (!previous || !/^\d{14}$/.test(previous) || previous < stamp) return stamp;
	const year = Number(previous.slice(0, 4));
	const bumped = new Date(Date.UTC(year, Number(previous.slice(4, 6)) - 1, Number(previous.slice(6, 8)), Number(previous.slice(8, 10)), Number(previous.slice(10, 12)), Number(previous.slice(12, 14)) + 1));
	return `${pad(bumped.getUTCFullYear(), 4)}${pad(bumped.getUTCMonth() + 1)}${pad(bumped.getUTCDate())}${pad(bumped.getUTCHours())}${pad(bumped.getUTCMinutes())}${pad(bumped.getUTCSeconds())}`;
}

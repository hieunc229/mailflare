import { getDatabaseConfig } from "./src/db/with-database";
import { withD1Session } from "./src/lib/d1-session-context";
import { isMissingColumnError, isMissingTableError } from "./src/lib/database-errors";
import { deadLetterInboundMail } from "./src/lib/email/dead-letter";
import type { InboundQueueMessage } from "./src/lib/email/inbound";
import type { WebhookRetryMessage } from "./src/lib/email/webhooks";
import type { ImportJobMessage } from "./src/lib/import/jobs-types";

export function isInboundQueueMessage(payload: unknown): payload is InboundQueueMessage {
	return (
		typeof payload === "object" &&
		payload !== null &&
		"rawR2Key" in payload &&
		"from" in payload &&
		"to" in payload
	);
}

export function isWebhookRetryMessage(payload: unknown): payload is WebhookRetryMessage {
	return (
		typeof payload === "object" &&
		payload !== null &&
		(payload as { kind?: unknown }).kind === "webhook.retry" &&
		typeof (payload as { deliveryId?: unknown }).deliveryId === "string"
	);
}

export function isImportJobMessage(payload: unknown): payload is ImportJobMessage {
	return (
		typeof payload === "object" &&
		payload !== null &&
		(payload as { kind?: unknown }).kind === "import.run" &&
		typeof (payload as { jobId?: unknown }).jobId === "string"
	);
}

/**
 * The cookie carrying the D1 read-session bookmark between requests. Each response stores the
 * session's newest bookmark so the next request can resume where this one left off: reads can
 * then be served by D1 read replicas while the client still observes its own writes
 * (sequential consistency). Without it reads always hit the primary.
 */
export const D1_SESSION_COOKIE = "mf-d1-bm";

/** The bookmark the client's last response left on it, if any. */
export function d1SessionBookmark(request: Request): string | undefined {
	const cookie = request.headers.get("cookie");
	if (!cookie) return undefined;
	for (const part of cookie.split(";")) {
		const separator = part.indexOf("=");
		if (separator === -1) continue;
		if (part.slice(0, separator).trim() !== D1_SESSION_COOKIE) continue;
		const raw = part.slice(separator + 1).trim();
		if (!raw) return undefined;
		try {
			return decodeURIComponent(raw) || undefined;
		} catch {
			return raw;
		}
	}
	return undefined;
}

export interface D1ReadSession {
	env: CloudflareEnv;
	session: D1DatabaseSession;
}

/**
 * Serves this request's reads from D1 read replicas: swaps `env.DB` for a `withSession` handle
 * anchored at the client's bookmark (or `first-unconstrained` on the first visit) and returns
 * the session so the response can carry its newest bookmark back to the client. Only for the
 * D1 binding — `withDatabase` replaces `env.DB` for `DATABASE_URL`/Hyperdrive databases, which
 * have no such sessions — and proxied rather than spread because Worker bindings are not
 * enumerable.
 */
export function withD1ReadSession(env: CloudflareEnv, request: Request): D1ReadSession | null {
	if (!shouldUseD1Session(request)) return null;
	if (getDatabaseConfig(env).driver !== "d1") return null;
	const database = env.DB;
	if (!database || typeof database.withSession !== "function") return null;
	// A mutation without a bookmark starts on the primary; reads may start anywhere.
	const fallback = isReadRequest(request) ? "first-unconstrained" : "first-primary";
	const session = database.withSession(d1SessionBookmark(request) ?? fallback);
	// `DB_PRIMARY` keeps the raw primary binding reachable: authentication reads must not
	// accept a lagging replica's copy of sessions/users (a session revoked on another
	// device, or a freshly disabled account, has no bookmark covering it).
	return { env: withD1Session(env, session), session };
}

function isReadRequest(request: Request): boolean {
	return request.method === "GET" || request.method === "HEAD";
}

/** Paths whose reads must be current: sign-in, single-use tokens, setup and public write endpoints. */
const PRIMARY_ONLY_PREFIXES = ["/api/auth/", "/api/setup", "/api/seed", "/api/inbound", "/api/provider-events", "/api/i/"];

/**
 * Replica reads can lag writes the client's bookmark does not cover (other devices, inbound
 * mail, queue jobs). Anything that consumes a single-use secret or has no signed-in client
 * stays on the primary.
 */
export function shouldUseD1Session(request: Request): boolean {
	const { pathname } = new URL(request.url);
	return !PRIMARY_ONLY_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

/**
 * Stores the session's newest bookmark on the client so the next request continues where this
 * one left off. `getBookmark()` is null until a query ran on the session (and missing on
 * stand-in `env.DB` implementations), in which case the response is returned untouched.
 *
 * Only mutations (and the cookie-less first visit) set the cookie: a slow read-only request
 * finishing after a write would otherwise overwrite the newer bookmark with an older one and
 * break the read-your-writes guarantee. Concurrent mutation bookmarks are ordered on the
 * primary, so whichever lands last stays consistent.
 */
export function withD1BookmarkCookie(request: Request, response: Response, session: D1ReadSession["session"] | null | undefined): Response {
	if ((request.method === "GET" || request.method === "HEAD") && d1SessionBookmark(request)) return response;
	const bookmark = typeof session?.getBookmark === "function" ? session.getBookmark() : null;
	if (!bookmark) return response;
	const copy = new Response(response.body, response);
	copy.headers.append("Set-Cookie", `${D1_SESSION_COOKIE}=${encodeURIComponent(bookmark)}; HttpOnly; SameSite=Lax; Path=/`);
	return copy;
}

/** Retries inbound mail waits this long when the schema is behind the code; see docs/deployment.md. */
export const INBOUND_SCHEMA_RETRY_DELAY_SECONDS = 300;

/** Must match `max_retries` on the mailflare-inbound consumer in wrangler.jsonc. */
export const INBOUND_MAX_RETRIES = 12;

/** Backoff for other failures: 10 s doubling to a 1 h cap, so 12 retries span about 4 hours. */
export function inboundRetryDelaySeconds(attempts: number): number {
	return Math.min(10 * 2 ** Math.max(0, attempts - 1), 3600);
}

/** True when the queue will drop the message if this attempt fails too (`attempts` counts from 1). */
export function isFinalInboundAttempt(attempts: number): boolean {
	return attempts > INBOUND_MAX_RETRIES;
}

/**
 * After a failed inbound delivery: a missing column or table means the new code is live but its
 * migration is not applied yet, so retry slowly (the queue's max_retries then spans about an
 * hour, long enough for the 5-minute auto-update cron or an admin). Any other error backs off
 * from 10 s to 1 h; that is safe because inbound processing skips an already-stored
 * `rawR2Key`, so a retry never duplicates mail. The caller moves the raw mail aside on the
 * final attempt (`deadLetterInboundMail`) instead of calling this.
 */
export function settleFailedInboundMessage(msg: { attempts?: number; retry(options: { delaySeconds: number }): void }, error: unknown): void {
	if (isMissingColumnError(error) || isMissingTableError(error)) msg.retry({ delaySeconds: INBOUND_SCHEMA_RETRY_DELAY_SECONDS });
	else msg.retry({ delaySeconds: inboundRetryDelaySeconds(msg.attempts ?? 1) });
}

/**
 * Queue handler step for a failed inbound message. On the final attempt (the queue drops the message after
 * it, and the sweeper deletes unreferenced raw mail) the raw object is moved to `dead/` and the message
 * acked. If that move fails, fall back to a normal retry; the queue then drops the message and the mail is lost.
 */
export async function settleInboundFailure(
	msg: { attempts: number; body: InboundQueueMessage; ack(): void; retry(options: { delaySeconds: number }): void },
	env: Pick<CloudflareEnv, "BUCKET">,
	error: unknown,
): Promise<void> {
	if (!isFinalInboundAttempt(msg.attempts)) return settleFailedInboundMessage(msg, error);
	try {
		const key = await deadLetterInboundMail(env, msg.body, error);
		console.error("Inbound mail dead-lettered", { rawR2Key: msg.body.rawR2Key, deadKey: key, recipient: msg.body.to });
		msg.ack();
	} catch (deadError) {
		console.error("Inbound dead-letter failed, mail will be lost when the queue drops this message", { rawR2Key: msg.body.rawR2Key, error: deadError });
		settleFailedInboundMessage(msg, error);
	}
}

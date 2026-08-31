import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { users } from "@/db/schema";

/**
 * Bark push notification service.
 *
 * Sends a push notification to the user's iPhone via the Bark app
 * (https://bark.day.app). Behavior mirrors the cloud-mail reference
 * implementation: the push title is the destination inbox address and the
 * body is the email subject. Push failures never affect the email pipeline.
 */

export const BARK_GROUP = "Mailflare";

export type BarkPushPayload = {
	title: string;
	body: string;
	group?: string;
};

/**
 * Reads the configured Bark URL for a user (normalized) or null.
 */
export async function getUserBarkUrl(
	env: CloudflareEnv,
	userId: string,
): Promise<string | null> {
	try {
		const db = getDb(env);
		const [user] = await db
			.select({ barkUrl: users.barkUrl })
			.from(users)
			.where(eq(users.id, userId))
			.limit(1);
		return normalizeBarkUrl(user?.barkUrl);
	} catch (error) {
		console.error("Failed to load Bark URL:", error instanceof Error ? error.message : error);
		return null;
	}
}

/**
 * Push a new incoming message notification to a user's devices via Bark.
 * Title = destination inbox address, body = email subject. Never throws.
 */
export async function notifyUserOfBarkMessage(
	env: CloudflareEnv,
	userId: string,
	message: { toAddr?: string | null; subject?: string | null },
): Promise<void> {
	const barkUrl = await getUserBarkUrl(env, userId);
	if (!barkUrl) return;
	await sendBarkNotification(barkUrl, {
		title: message.toAddr || "",
		body: message.subject || "",
	});
}

/**
 * Normalizes a user-provided Bark push URL.
 *
 * Security: this value is user-supplied and later fetched by the worker during
 * inbound email processing, so it is a SSRF sink. We therefore:
 * - only accept https: URLs (never http:, file:, data:, ftp:, ...),
 * - reject private/loopback/link-local/reserved hosts and IP literals
 *   (the worker cannot reach a user's LAN anyway, so no legitimate use is lost),
 * - accept a bare Bark device key and convert it to the default https endpoint,
 * - return the normalized URL (or null when empty/invalid).
 */
export function normalizeBarkUrl(value: string | null | undefined): string | null {
	if (!value) return null;
	const trimmed = value.trim();
	if (!trimmed) return null;

	// Bare device key -> default Bark HTTPS endpoint.
	if (/^[0-9A-Za-z_-]{10,}$/.test(trimmed)) {
		return `https://api.day.app/${trimmed}`;
	}

	// Full URL branch.
	let parsed: URL;
	try {
		parsed = new URL(trimmed);
	} catch {
		return null;
	}
	if (parsed.protocol !== "https:") {
		return null;
	}
	if (isPrivateHostname(parsed.hostname)) {
		return null;
	}
	// Normalize: drop the hash so the stored value is canonical.
	parsed.hash = "";
	return parsed.toString();
}

/**
 * Returns true when a hostname is private/local/reserved space that a
 * Cloudflare worker must never fetch (SSRF protection).
 */
function isPrivateHostname(hostname: string): boolean {
	const lower = hostname.toLowerCase();
	if (lower === "localhost" || lower.endsWith(".localhost")) {
		return true;
	}
	// IPv6 literal.
	if (lower.includes(":")) {
		// URL.hostname keeps the brackets for IPv6 literals (e.g. "[::1]").
		const v6 = lower.startsWith("[") && lower.endsWith("]") ? lower.slice(1, -1) : lower;
		if (
			v6 === "::1" ||
			v6.startsWith("fc") ||
			v6.startsWith("fd") ||
			v6.startsWith("fe8") ||
			v6.startsWith("fe9") ||
			v6.startsWith("fea") ||
			v6.startsWith("feb") ||
			v6.startsWith("::") ||
			v6.startsWith("0:")
		) {
			return true;
		}
		return false;
	}
	// IPv4 literal.
	if (/^\d{1,3}(\.\d{1,3}){3}$/.test(lower)) {
		const [a, b] = lower.split(".").map(Number);
		// 0/8, 10/8, 127/8 loopback, 169.254/16 link-local, 172.16-31/12,
		// 192.168/16, 192.0.0/24, 198.18/15 benchmark, 224+ multicast/reserved.
		if (
			a === 0 ||
			a === 10 ||
			a === 127 ||
			(a === 169 && b === 254) ||
			(a === 172 && b >= 16 && b <= 31) ||
			(a === 192 && (b === 168 || b === 0)) ||
			(a === 198 && (b === 18 || b === 19)) ||
			a >= 224
		) {
			return true;
		}
		return false;
	}
	return false;
}

/**
 * Sends a Bark push notification.
 *
 * Uses POST JSON to the user's Bark URL. Failures are logged and swallowed so
 * the email receive pipeline is never blocked by a notification problem.
 */
export async function sendBarkNotification(barkUrl: string, payload: BarkPushPayload): Promise<boolean> {
	// Cloudflare Workers does not support AbortSignal.timeout; build a manual
	// timeout with AbortController to bound slow/unreachable push endpoints.
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), 10_000);
	try {
		const res = await fetch(barkUrl, {
			method: "POST",
			headers: {
				"Content-Type": "application/json; charset=utf-8",
			},
			body: JSON.stringify({
				title: payload.title,
				body: payload.body,
				group: payload.group ?? BARK_GROUP,
			}),
			// SSRF hardening: never follow redirects and bound the request time.
			redirect: "manual",
			signal: controller.signal,
		});

		if (!res.ok) {
			console.error(`Bark push failed status: ${res.status} response: ${await res.text()}`);
			return false;
		}
		return true;
	} catch (error) {
		console.error("Bark push exception:", error instanceof Error ? error.message : error);
		return false;
	} finally {
		clearTimeout(timer);
	}
}
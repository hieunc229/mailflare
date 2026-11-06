import { assertResolvesPublic, isPublicHttpsUrl } from "@/lib/security/public-url";

const ONE_CLICK_TIMEOUT_MS = 10_000;
const WINDOW_MS = 60_000;
const MAX_REQUESTS = 30;

const windows = new Map<string, { start: number; count: number }>();

/** Fixed-window limit on unsubscribe attempts per user; keeps the mailto path from being an outbound amplifier. */
export function allowUnsubscribeRequest(userId: string, now = Date.now()): boolean {
	const current = windows.get(userId);
	if (!current || now - current.start >= WINDOW_MS) {
		windows.set(userId, { start: now, count: 1 });
		return true;
	}
	current.count += 1;
	return current.count <= MAX_REQUESTS;
}

/**
 * RFC 8058 one-click: POST `List-Unsubscribe=One-Click` to the https URI.
 * Any 2xx or 3xx counts as success; redirects are never followed, so the
 * endpoint cannot bounce the request to an internal address.
 */
export async function postOneClickUnsubscribe(url: string): Promise<boolean> {
	if (!isPublicHttpsUrl(url)) return false;
	try {
		await assertResolvesPublic(new URL(url).hostname);
	} catch {
		return false;
	}
	try {
		const response = await fetch(url, {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: "List-Unsubscribe=One-Click",
			redirect: "manual",
			signal: AbortSignal.timeout(ONE_CLICK_TIMEOUT_MS),
		});
		return response.status >= 200 && response.status < 400;
	} catch {
		return false;
	}
}

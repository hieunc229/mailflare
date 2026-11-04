const WINDOW_MS = 60_000;
const MAX_REQUESTS = 300;
const MAX_TRACKED = 5_000;

const windows = new Map<string, { start: number; count: number }>();

/**
 * Fixed-window limit per user on proxied images, so a message with thousands of unique image URLs
 * cannot turn the proxy into a request amplifier. State is per isolate/process, which is enough to
 * bound a single noisy client.
 */
export function allowRemoteImageRequest(userId: string, now = Date.now()): boolean {
	const current = windows.get(userId);
	if (!current || now - current.start >= WINDOW_MS) {
		if (windows.size >= MAX_TRACKED) {
			for (const [key, entry] of windows) if (now - entry.start >= WINDOW_MS) windows.delete(key);
			if (windows.size >= MAX_TRACKED) windows.clear();
		}
		windows.set(userId, { start: now, count: 1 });
		return true;
	}
	current.count += 1;
	return current.count <= MAX_REQUESTS;
}

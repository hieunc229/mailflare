import { readFile } from "node:fs/promises";
import { extname, join, resolve, sep } from "node:path";

/** A fixed-window limiter with the `RateLimit` binding's shape. */
export function openRateLimiter(limit: number, periodSeconds: number): RateLimit {
	const windows = new Map<string, { count: number; resetAt: number }>();
	return {
		async limit({ key }: { key: string }) {
			const now = Date.now();
			const current = windows.get(key);
			if (!current || current.resetAt <= now) {
				windows.set(key, { count: 1, resetAt: now + periodSeconds * 1000 });
				return { success: true };
			}
			current.count += 1;
			return { success: current.count <= limit };
		},
	} as unknown as RateLimit;
}

const CONTENT_TYPES: Record<string, string> = {
	".png": "image/png",
	".ico": "image/x-icon",
	".svg": "image/svg+xml",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".webp": "image/webp",
	".json": "application/json",
	".txt": "text/plain",
};

/** The `ASSETS` fetcher over the public directory. */
export function openAssets(publicDir: string): Fetcher {
	const root = resolve(publicDir);
	return {
		async fetch(input: RequestInfo | URL) {
			const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
			const path = resolve(join(root, url.pathname));
			if (path !== root && !path.startsWith(root + sep)) return new Response("Not found", { status: 404 });
			try {
				const body = await readFile(path);
				return new Response(body, { headers: { "Content-Type": CONTENT_TYPES[extname(path)] ?? "application/octet-stream" } });
			} catch {
				return new Response("Not found", { status: 404 });
			}
		},
	} as unknown as Fetcher;
}

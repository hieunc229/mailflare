import { openRateLimiter } from "./misc";

export type UpstashConfig = { url: string; token: string };

type Vars = Record<string, string | undefined>;

/** Upstash's own names, or the `KV_REST_API_*` names Vercel's marketplace integration creates. */
export function readUpstashConfig(vars: Vars): UpstashConfig | null {
	const url = (vars.UPSTASH_REDIS_REST_URL ?? vars.KV_REST_API_URL)?.trim().replace(/\/+$/, "");
	const token = (vars.UPSTASH_REDIS_REST_TOKEN ?? vars.KV_REST_API_TOKEN)?.trim();
	return url && token ? { url, token } : null;
}

const TIMEOUT_MS = 2000;

/**
 * A fixed-window limiter with the `RateLimit` binding's shape, counted in Upstash Redis so every function
 * instance shares it. When Redis cannot be reached it counts in memory instead, which still slows a single
 * instance down rather than letting everything through.
 */
export function openUpstashRateLimiter(config: UpstashConfig, name: string, limit: number, periodSeconds: number): RateLimit {
	const local = openRateLimiter(limit, periodSeconds);
	return {
		async limit({ key }: { key: string }) {
			const window = Math.floor(Date.now() / (periodSeconds * 1000));
			const redisKey = `mailflare:rate:${name}:${window}:${key}`;
			try {
				const response = await fetch(`${config.url}/pipeline`, {
					method: "POST",
					headers: { Authorization: `Bearer ${config.token}`, "Content-Type": "application/json" },
					body: JSON.stringify([["INCR", redisKey], ["EXPIRE", redisKey, periodSeconds * 2]]),
					signal: AbortSignal.timeout(TIMEOUT_MS),
				});
				if (!response.ok) throw new Error(`Upstash answered ${response.status}`);
				const [increment] = (await response.json()) as Array<{ result?: unknown; error?: string }>;
				if (typeof increment?.result !== "number") throw new Error(increment?.error ?? "Upstash returned no count");
				return { success: increment.result <= limit };
			} catch (error) {
				console.warn("Upstash rate limiter unavailable, counting in memory", error);
				return local.limit({ key });
			}
		},
	} as unknown as RateLimit;
}

import type { DatabaseDialect } from "@/db/dialect";
import { isMissingTableError } from "@/lib/database-errors";
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

/** Created on first use, so only Vercel installations have it. Throwaway counters, left out of backups. */
const TABLE = "vercel_rate_limits";
const CREATE_TABLE = `CREATE TABLE IF NOT EXISTS ${TABLE} (bucket VARCHAR(255) NOT NULL PRIMARY KEY, hits BIGINT NOT NULL, expires_at BIGINT NOT NULL)`;
/** The share of requests that also delete finished windows. */
const SWEEP_CHANCE = 0.02;

export type RateLimitStore = { db: () => D1Database; dialect: DatabaseDialect };

async function countHit(store: RateLimitStore, bucket: string, expiresAt: number): Promise<number> {
	const db = store.db();
	const insert = `INSERT INTO ${TABLE} (bucket, hits, expires_at) VALUES (?, 1, ?)`;
	let row: { hits: number | string } | null;
	if (store.dialect === "mysql") {
		await db.prepare(`${insert} ON DUPLICATE KEY UPDATE hits = hits + 1`).bind(bucket, expiresAt).run();
		row = await db.prepare(`SELECT hits FROM ${TABLE} WHERE bucket = ?`).bind(bucket).first();
	} else {
		row = await db.prepare(`${insert} ON CONFLICT (bucket) DO UPDATE SET hits = ${TABLE}.hits + 1 RETURNING hits`).bind(bucket, expiresAt).first();
	}
	// PostgreSQL drivers may hand a bigint back as a string.
	const hits = Number(row?.hits);
	if (!Number.isFinite(hits)) throw new Error("The rate limit counter returned no value");
	return hits;
}

async function sha256Hex(value: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
	return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * The default limiter on Vercel: the same fixed window, counted in the app's own database so every function
 * instance shares it without another service. Keys are hashed (they hold client addresses). When the
 * database cannot be reached it counts in memory, as the Upstash limiter does.
 */
export function openDatabaseRateLimiter(store: RateLimitStore, name: string, limit: number, periodSeconds: number): RateLimit {
	const local = openRateLimiter(limit, periodSeconds);
	return {
		async limit({ key }: { key: string }) {
			const now = Math.floor(Date.now() / 1000);
			const window = Math.floor(now / periodSeconds);
			try {
				const bucket = `${name}:${window}:${await sha256Hex(key)}`;
				const expiresAt = (window + 2) * periodSeconds;
				const hits = await countHit(store, bucket, expiresAt).catch(async (error) => {
					if (!isMissingTableError(error)) throw error;
					// Two instances creating it at once can make one of them fail; the count below settles it.
					await store.db().prepare(CREATE_TABLE).run().catch(() => undefined);
					return countHit(store, bucket, expiresAt);
				});
				if (Math.random() < SWEEP_CHANCE) {
					await store.db().prepare(`DELETE FROM ${TABLE} WHERE expires_at < ?`).bind(now).run().catch(() => undefined);
				}
				return { success: hits <= limit };
			} catch (error) {
				console.warn("Database rate limiter unavailable, counting in memory", error);
				return local.limit({ key });
			}
		},
	} as unknown as RateLimit;
}

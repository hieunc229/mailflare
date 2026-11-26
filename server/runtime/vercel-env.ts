import { resolveDatabaseConfig } from "@/db/dialect";
import { getObjectStorageConfig } from "@/lib/storage/b2-config";
import { mailerConfigFromEnv, openMailer } from "./mailer";
import { openVercelAssets } from "./vercel-assets";
import { openQStashQueue, readQStashConfig } from "./vercel-queue";
import { openUpstashRateLimiter, readUpstashConfig } from "./vercel-rate-limit";

/** Database drivers that keep data in a local file or in process memory, which a Vercel function loses. */
const LOCAL_DRIVERS = ["d1", "better-sqlite3", "bun-sqlite", "pglite"];

type Vars = Record<string, string | undefined>;

/** The public origin: `APP_URL`, else the production domain Vercel itself reports. */
export function vercelAppUrl(vars: Vars): string | undefined {
	const explicit = vars.APP_URL?.trim();
	const production = vars.VERCEL_PROJECT_PRODUCTION_URL?.trim();
	const value = explicit || (production ? `https://${production}` : "");
	try {
		return value ? new URL(value).origin : undefined;
	} catch {
		return undefined;
	}
}

/** One line per missing setting; empty when the runtime can start. */
export function vercelConfigProblems(vars: Vars): string[] {
	const problems: string[] = [];
	let database: { driver: string; url?: string } | null = null;
	try {
		database = resolveDatabaseConfig({ DATABASE_URL: vars.DATABASE_URL, DATABASE_DRIVER: vars.DATABASE_DRIVER, DATABASE_AUTH_TOKEN: vars.DATABASE_AUTH_TOKEN });
	} catch (error) {
		problems.push(error instanceof Error ? error.message : "DATABASE_URL is invalid");
	}
	if (database && (!vars.DATABASE_URL?.trim() || LOCAL_DRIVERS.includes(database.driver) || database.url?.startsWith("file:"))) {
		problems.push("DATABASE_URL must point at a hosted PostgreSQL, MySQL or libSQL (Turso) database");
	}
	if (!getObjectStorageConfig(vars as Parameters<typeof getObjectStorageConfig>[0])) {
		problems.push("Object storage is required: S3_BUCKET, S3_REGION and credentials, or B2_KEY_ID, B2_APPLICATION_KEY, B2_BUCKET and B2_ENDPOINT");
	}
	if (!readQStashConfig(vars)) problems.push("QStash is required: QSTASH_TOKEN, QSTASH_CURRENT_SIGNING_KEY and QSTASH_NEXT_SIGNING_KEY");
	if (!readUpstashConfig(vars)) problems.push("Upstash Redis is required for rate limits: UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN");
	if (!vars.CRON_SECRET?.trim()) problems.push("CRON_SECRET is required for the cron routes");
	if (!vercelAppUrl(vars)) problems.push("APP_URL is required (the public https address of this deployment)");
	return problems;
}

/**
 * Assemble a `CloudflareEnv` for a Vercel function. Every variable passes through, as on Workers; the bindings
 * Cloudflare would provide are replaced by hosted services. `DB` and `BUCKET` are left to `withDatabase` and
 * `withStorage`, which `getEnv()` applies on every runtime.
 */
export function createVercelEnv(vars: Vars = process.env): CloudflareEnv {
	const problems = vercelConfigProblems(vars);
	if (problems.length) throw new Error(`Mailflare cannot run on Vercel yet (docs/vercel.md):\n- ${problems.join("\n- ")}`);
	const appUrl = vercelAppUrl(vars)!;
	const qstash = readQStashConfig(vars)!;
	const upstash = readUpstashConfig(vars)!;
	return {
		...vars,
		MAILFLARE_RUNTIME: "vercel",
		APP_URL: appUrl,
		DB: undefined,
		BUCKET: undefined,
		EMAIL: openMailer(mailerConfigFromEnv()),
		INBOUND_QUEUE: openQStashQueue("inbound", qstash, appUrl),
		OUTBOUND_QUEUE: openQStashQueue("outbound", qstash, appUrl),
		AGENT_QUEUE: openQStashQueue("agent", qstash, appUrl),
		// No WebSockets on Vercel: the browser polls. The stub stays so new-mail push notifications still go out.
		REALTIME: { getByName: () => ({ fetch: async () => new Response(null, { status: 204 }) }) },
		ASSETS: openVercelAssets(appUrl),
		IMAGES: undefined,
		WORKER_SELF_REFERENCE: undefined,
		LOGIN_RATE_LIMIT: openUpstashRateLimiter(upstash, "login", 20, 60),
		DEVICE_LOGIN_RATE_LIMIT: openUpstashRateLimiter(upstash, "device-login", 10, 60),
		DAV_RATE_LIMIT: openUpstashRateLimiter(upstash, "dav", 600, 60),
		AGENT_RATE_LIMIT: openUpstashRateLimiter(upstash, "agent", 120, 60),
		// Cloudflare-only bindings that a stray variable of the same name must not fake.
		AI: undefined,
		HYPERDRIVE: undefined,
	} as unknown as CloudflareEnv;
}

let cached: CloudflareEnv | undefined;

export function getVercelEnv(): CloudflareEnv {
	cached ??= createVercelEnv();
	return cached;
}

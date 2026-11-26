import { resolveDatabaseConfig } from "@/db/dialect";
import { withDatabase } from "@/db/with-database";
import { describeB2Problem, getObjectStorageConfig } from "@/lib/storage/b2-config";
import { mailerConfigFromEnv, openMailer } from "./mailer";
import { openVercelAssets } from "./vercel-assets";
import { readBlobCredentials, VercelBlobBucket } from "./vercel-blob";
import { openQStashQueue, readQStashConfig, type QueueName } from "./vercel-queue";
import { openVercelQueue, openVercelQueues } from "./vercel-queues";
import { openDatabaseRateLimiter, openUpstashRateLimiter, readUpstashConfig, type RateLimitStore } from "./vercel-rate-limit";

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

const QSTASH_VARS = ["QSTASH_TOKEN", "QSTASH_CURRENT_SIGNING_KEY", "QSTASH_NEXT_SIGNING_KEY"];

/**
 * Vercel's Turso integration ("Connect Project") names its variables `TURSO_DATABASE_URL` and
 * `TURSO_AUTH_TOKEN`. They are used when `DATABASE_URL` is unset.
 */
export function withTursoVars(vars: Vars): Vars {
	if (vars.DATABASE_URL?.trim() || !vars.TURSO_DATABASE_URL?.trim()) return vars;
	return { ...vars, DATABASE_URL: vars.TURSO_DATABASE_URL, DATABASE_AUTH_TOKEN: vars.TURSO_AUTH_TOKEN };
}

/** One line per missing setting; empty when the runtime can start. */
export function vercelConfigProblems(input: Vars): string[] {
	const vars = withTursoVars(input);
	const problems: string[] = [];
	let database: { driver: string; url?: string } | null = null;
	try {
		database = resolveDatabaseConfig({ DATABASE_URL: vars.DATABASE_URL, DATABASE_DRIVER: vars.DATABASE_DRIVER, DATABASE_AUTH_TOKEN: vars.DATABASE_AUTH_TOKEN });
	} catch (error) {
		problems.push(error instanceof Error ? error.message : "DATABASE_URL is invalid");
	}
	if (database && (!vars.DATABASE_URL?.trim() || LOCAL_DRIVERS.includes(database.driver) || database.url?.startsWith("file:"))) {
		problems.push("DATABASE_URL must point at a hosted PostgreSQL, MySQL or libSQL (Turso) database, or connect Turso to the project (TURSO_DATABASE_URL, TURSO_AUTH_TOKEN)");
	}
	const storageVars = vars as Parameters<typeof getObjectStorageConfig>[0];
	if (!getObjectStorageConfig(storageVars)) {
		// A half-set S3 or Backblaze bucket must not silently fall through to Blob.
		const partial = describeB2Problem(storageVars);
		if (partial) problems.push(partial);
		else if (!readBlobCredentials(vars)) {
			problems.push("Object storage is required: connect a private Vercel Blob store (BLOB_STORE_ID or BLOB_READ_WRITE_TOKEN), or set S3_BUCKET, S3_REGION and credentials, or B2_KEY_ID, B2_APPLICATION_KEY, B2_BUCKET and B2_ENDPOINT");
		}
	}
	if (!readQStashConfig(vars) && QSTASH_VARS.some((name) => vars[name]?.trim())) {
		problems.push(`QStash is partly configured: set all of ${QSTASH_VARS.join(", ")}, or none of them to use Vercel Queues`);
	}
	if (!vars.CRON_SECRET?.trim()) problems.push("CRON_SECRET is required for the cron routes");
	if (!vercelAppUrl(vars)) problems.push("APP_URL is required (the public https address of this deployment)");
	return problems;
}

/**
 * Assemble a `CloudflareEnv` for a Vercel function. Every variable passes through, as on Workers; the bindings
 * Cloudflare would provide are replaced by hosted services. `DB` is left to `withDatabase`, and `BUCKET` to
 * `withStorage` unless Vercel Blob is the storage; `getEnv()` applies both on every runtime.
 */
export function createVercelEnv(input: Vars = process.env): CloudflareEnv {
	const vars = withTursoVars(input);
	const problems = vercelConfigProblems(vars);
	if (problems.length) throw new Error(`Mailflare cannot run on Vercel yet (docs/vercel.md):\n- ${problems.join("\n- ")}`);
	const appUrl = vercelAppUrl(vars)!;
	// Vercel Queues and database counters by default; QStash and Upstash when their variables are set.
	const qstash = readQStashConfig(vars);
	const upstash = readUpstashConfig(vars);
	const databaseVars = { DATABASE_URL: vars.DATABASE_URL, DATABASE_DRIVER: vars.DATABASE_DRIVER, DATABASE_AUTH_TOKEN: vars.DATABASE_AUTH_TOKEN, MAILFLARE_RUNTIME: "vercel" };
	const databaseEnv = databaseVars as unknown as CloudflareEnv;
	const store: RateLimitStore = { db: () => withDatabase(databaseEnv).DB, dialect: resolveDatabaseConfig(databaseVars).dialect };
	const rateLimit = (name: string, limit: number, period: number) =>
		upstash ? openUpstashRateLimiter(upstash, name, limit, period) : openDatabaseRateLimiter(store, name, limit, period);
	// An S3 or Backblaze bucket wins (`withStorage` serves it); otherwise the connected Vercel Blob store.
	const blobCredentials = getObjectStorageConfig(vars as Parameters<typeof getObjectStorageConfig>[0]) ? null : readBlobCredentials(vars);
	const blob = blobCredentials ? new VercelBlobBucket(blobCredentials) : undefined;
	const queue = (name: QueueName) => (qstash ? openQStashQueue(name, qstash, appUrl) : openVercelQueue(name));
	return {
		...vars,
		MAILFLARE_RUNTIME: "vercel",
		APP_URL: appUrl,
		DB: undefined,
		BUCKET: blob,
		UPLOAD_PRESIGNER: blob?.presignUpload,
		EMAIL: openMailer(mailerConfigFromEnv()),
		INBOUND_QUEUE: queue("inbound"),
		OUTBOUND_QUEUE: queue("outbound"),
		AGENT_QUEUE: queue("agent"),
		VERCEL_QUEUES: qstash ? undefined : openVercelQueues(vars.VERCEL_ENV),
		// No WebSockets on Vercel: the browser polls. The stub stays so new-mail push notifications still go out.
		REALTIME: { getByName: () => ({ fetch: async () => new Response(null, { status: 204 }) }) },
		ASSETS: openVercelAssets(appUrl),
		IMAGES: undefined,
		WORKER_SELF_REFERENCE: undefined,
		LOGIN_RATE_LIMIT: rateLimit("login", 20, 60),
		DEVICE_LOGIN_RATE_LIMIT: rateLimit("device-login", 10, 60),
		DAV_RATE_LIMIT: rateLimit("dav", 600, 60),
		AGENT_RATE_LIMIT: rateLimit("agent", 120, 60),
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

/**
 * Database selection. Pure (no imports) so the schema, drizzle-kit configs, scripts and tests can
 * all use it. `DATABASE_URL` picks an external database; without it the Cloudflare D1 binding
 * (or, self-hosted, the local SQLite file) is used.
 */
export type DatabaseDialect = "sqlite" | "postgres" | "mysql";

export type DatabaseDriver =
	| "d1"
	| "libsql"
	| "better-sqlite3"
	| "bun-sqlite"
	| "node-postgres"
	| "postgres-js"
	| "neon"
	| "pglite"
	| "mysql2"
	| "planetscale"
	/** One SQLite database per tenant in a Durable Object (src/lib/tenancy). Not selectable through DATABASE_DRIVER. */
	| "do-sqlite";

export interface DatabaseConfig {
	dialect: DatabaseDialect;
	driver: DatabaseDriver;
	/** Connection string; `undefined` only for the D1 binding. */
	url?: string;
	authToken?: string;
}

/** Names accepted in DATABASE_DRIVER, including friendly aliases for hosted services. */
export const DRIVER_ALIASES: Record<string, DatabaseDriver> = {
	d1: "d1",
	libsql: "libsql",
	turso: "libsql",
	"better-sqlite3": "better-sqlite3",
	sqlite: "better-sqlite3",
	"bun-sqlite": "bun-sqlite",
	bun: "bun-sqlite",
	"node-postgres": "node-postgres",
	pg: "node-postgres",
	postgres: "node-postgres",
	postgresql: "node-postgres",
	supabase: "node-postgres",
	"postgres-js": "postgres-js",
	postgresjs: "postgres-js",
	neon: "neon",
	vercel: "neon",
	pglite: "pglite",
	mysql2: "mysql2",
	mysql: "mysql2",
	tidb: "mysql2",
	mariadb: "mysql2",
	planetscale: "planetscale",
};

export const DRIVER_DIALECT: Record<DatabaseDriver, DatabaseDialect> = {
	d1: "sqlite",
	libsql: "sqlite",
	"better-sqlite3": "sqlite",
	"bun-sqlite": "sqlite",
	"node-postgres": "postgres",
	"postgres-js": "postgres",
	neon: "postgres",
	pglite: "postgres",
	mysql2: "mysql",
	planetscale: "mysql",
	"do-sqlite": "sqlite",
};

function schemeOf(url: string): string {
	return /^([a-z][a-z0-9+.-]*):/i.exec(url.trim())?.[1]?.toLowerCase() ?? "";
}

function hostOf(url: string): string {
	try {
		return new URL(url.replace(/^(postgres(ql)?|mysql2?|mariadb|libsql):/i, "https:")).hostname.toLowerCase();
	} catch {
		return "";
	}
}

/** Infer the driver from a connection string when DATABASE_DRIVER is not given. */
export function inferDriver(url: string): DatabaseDriver {
	const scheme = schemeOf(url);
	const host = hostOf(url);
	if (scheme === "postgres" || scheme === "postgresql") {
		if (host.endsWith(".neon.tech") || host.endsWith(".vercel-storage.com")) return "neon";
		return "node-postgres";
	}
	if (scheme === "pglite") return "pglite";
	if (scheme === "mysql" || scheme === "mysql2" || scheme === "mariadb") {
		if (host.endsWith(".psdb.cloud") || host.endsWith(".planetscale.com")) return "planetscale";
		return "mysql2";
	}
	if (scheme === "libsql" || scheme === "wss" || scheme === "ws" || scheme === "http" || scheme === "https") return "libsql";
	if (scheme === "file" || scheme === "sqlite" || !scheme) return "better-sqlite3";
	throw new Error(`Cannot infer a database driver from DATABASE_URL scheme "${scheme}". Set DATABASE_DRIVER.`);
}

type EnvLike = Record<string, unknown> | undefined | null;

function text(env: EnvLike, key: string): string | undefined {
	const value = env?.[key];
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/**
 * Resolve the database from env vars. `DATABASE_URL` (or, on Workers, a Hyperdrive binding) selects an
 * external database; no URL means D1. Throws on an unsupported driver name or a driver/URL mismatch.
 */
export function resolveDatabaseConfig(env: EnvLike, hyperdriveUrl?: string): DatabaseConfig {
	const url = text(env, "DATABASE_URL") ?? hyperdriveUrl;
	const driverName = text(env, "DATABASE_DRIVER")?.toLowerCase();
	if (!url) {
		if (driverName && driverName !== "d1") throw new Error(`DATABASE_DRIVER=${driverName} needs DATABASE_URL (or a HYPERDRIVE binding).`);
		return { dialect: "sqlite", driver: "d1" };
	}
	let driver: DatabaseDriver;
	if (driverName) {
		driver = DRIVER_ALIASES[driverName];
		if (!driver) throw new Error(`Unsupported DATABASE_DRIVER "${driverName}". Supported: ${Object.keys(DRIVER_ALIASES).join(", ")}.`);
	} else {
		driver = inferDriver(url);
	}
	return { dialect: DRIVER_DIALECT[driver], driver, url, authToken: text(env, "DATABASE_AUTH_TOKEN") };
}

/**
 * The dialect the schema module builds its tables for. Read from `process.env` at import time
 * (Workers populate it from vars and secrets), with `MAILFLARE_DB_DIALECT` to force one for tooling.
 */
export function schemaDialect(): DatabaseDialect {
	const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
	const forced = text(env, "MAILFLARE_DB_DIALECT");
	if (forced === "sqlite" || forced === "postgres" || forced === "mysql") return forced;
	if (forced) throw new Error(`MAILFLARE_DB_DIALECT must be sqlite, postgres or mysql, got "${forced}".`);
	const named = text(env, "DATABASE_DRIVER")?.toLowerCase();
	// A driver without a URL is the Hyperdrive case: the connection string only exists at request time.
	if (named && !text(env, "DATABASE_URL") && DRIVER_ALIASES[named]) return DRIVER_DIALECT[DRIVER_ALIASES[named]];
	try {
		return resolveDatabaseConfig(env).dialect;
	} catch {
		return "sqlite";
	}
}

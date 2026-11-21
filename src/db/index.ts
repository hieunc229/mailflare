import { drizzle } from "drizzle-orm/d1";
import { schema } from "@/db/schema";
import type { DatabaseDialect } from "./dialect";
import { isExternalDatabase } from "./external";

export type AppDatabase = ReturnType<typeof createD1Db>;

function createD1Db(d1: D1Database) {
	return drizzle(d1, { schema });
}

/**
 * The drizzle instance for `env.DB`. That is the D1 binding by default; when `DATABASE_URL` selects another
 * database `env.DB` is an external database (see `withDatabase`) that builds its own dialect's instance.
 * Everything is typed as SQLite, the dialect the app is written against (see compat.ts).
 */
export function createDb(d1: D1Database): AppDatabase {
	if (isExternalDatabase(d1)) return d1.createDrizzle(schema as never) as AppDatabase;
	return createD1Db(d1);
}

export function getDb(env: Pick<CloudflareEnv, "DB">) {
	if (!env.DB) {
		throw new Error("No database binding configured");
	}
	return createDb(env.DB);
}

export { schema };

/** The dialect `env.DB` speaks; SQLite for the D1 binding and for anything that is not an external database. */
export function getDialect(env: Pick<CloudflareEnv, "DB">): DatabaseDialect {
	return isExternalDatabase(env.DB) ? env.DB.config.dialect : "sqlite";
}

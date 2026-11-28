import { drizzle as mysqlProxy } from "drizzle-orm/mysql-proxy";
import { drizzle as pgProxy } from "drizzle-orm/pg-proxy";
import { drizzle as sqliteProxy } from "drizzle-orm/sqlite-proxy";
import { wrapDatabase, currentExecutor, type ExecutorContext } from "./compat";
import { CompatDatabase } from "./d1-compat";
import type { DatabaseConfig } from "./dialect";
import { openMysql2, openPlanetScale } from "./drivers/mysql";
import { openNeon, openNodePostgres, openPglite, openPostgresJs } from "./drivers/postgres";
import { openBetterSqlite3, openBunSqlite, openLibsql } from "./drivers/sqlite";
import type { OpenOptions, SqlExecutor } from "./drivers/types";

/**
 * A database reached through `DATABASE_URL` instead of the D1 binding. It stands in for `env.DB`: it has
 * the D1 methods (prepare/batch/exec) for raw-SQL call sites and carries the drizzle instance factory
 * `createDb` looks for.
 */
export interface ExternalDatabase extends CompatDatabase {
	readonly config: DatabaseConfig;
	readonly sqlExecutor: SqlExecutor;
	createDrizzle(schema: Record<string, unknown>): unknown;
}

export function openExecutor(config: DatabaseConfig, shared: boolean): SqlExecutor {
	const options: OpenOptions = { url: config.url ?? "", authToken: config.authToken, shared };
	switch (config.driver) {
		case "node-postgres":
			return openNodePostgres(options);
		case "postgres-js":
			return openPostgresJs(options);
		case "neon":
			return openNeon(options);
		case "pglite":
			return openPglite(options);
		case "mysql2":
			return openMysql2(options);
		case "planetscale":
			return openPlanetScale(options);
		case "libsql":
			return openLibsql(options);
		case "better-sqlite3":
			return openBetterSqlite3(options);
		case "bun-sqlite":
			return openBunSqlite(options);
		default:
			throw new Error(`No executor for database driver "${config.driver}".`);
	}
}

function withAffected(rows: unknown[], affectedRows: number) {
	Object.defineProperty(rows, "affectedRows", { value: affectedRows, enumerable: false });
	return rows;
}

function buildDrizzle(config: DatabaseConfig, ctx: ExecutorContext, schema: Record<string, unknown>) {
	const executor = () => currentExecutor(ctx);
	if (config.dialect === "postgres") {
		const db = pgProxy(
			async (sql, params, method) => {
				const result = await executor().query(sql, params, method === "all" ? "array" : "object");
				return { rows: withAffected(result.rows, result.affectedRows) as never[] };
			},
			{ schema },
		);
		return wrapDatabase(db, "postgres", ctx);
	}
	if (config.dialect === "mysql") {
		const db = mysqlProxy(
			async (sql, params, method) => {
				const result = await executor().query(sql, params, method === "all" ? "array" : "object");
				if (method === "all") return { rows: result.rows as never[] };
				return { rows: [{ insertId: result.insertId ?? 0, affectedRows: result.affectedRows }] as never[], insertId: result.insertId, affectedRows: result.affectedRows };
			},
			{ schema },
		);
		return wrapDatabase(db, "mysql", ctx);
	}
	const db = sqliteProxy(
		async (sql, params, method) => {
			const result = await executor().query(sql, params, "array");
			if (method === "run") return { rows: [] as never[] };
			if (method === "get") return { rows: result.rows[0] as never };
			return { rows: result.rows as never[] };
		},
		{ schema },
	);
	return wrapDatabase(db, "sqlite", ctx);
}

export function openExternalDatabase(config: DatabaseConfig, shared: boolean): ExternalDatabase {
	const base = openExecutor(config, shared);
	const ctx: ExecutorContext = { base, tx: null };
	const compat = new CompatDatabase(config.dialect, base, () => ctx.tx) as ExternalDatabase;
	Object.defineProperties(compat, {
		config: { value: config },
		sqlExecutor: { value: base },
		createDrizzle: {
			value: (schema: Record<string, unknown>) => buildDrizzle(config, { base, tx: null }, schema),
		},
	});
	return compat;
}

export function isExternalDatabase(value: unknown): value is ExternalDatabase {
	return !!value && typeof (value as ExternalDatabase).createDrizzle === "function";
}

// Prints the table/column/index layout of the schema built for the dialect in MAILFLARE_DB_DIALECT.
import { getTableConfig as pgConfig } from "drizzle-orm/pg-core";
import { getTableConfig as mysqlConfig } from "drizzle-orm/mysql-core";
import { getTableConfig as sqliteConfig } from "drizzle-orm/sqlite-core";
import * as schema from "../../src/db/schema/index";

const dialect = process.env.MAILFLARE_DB_DIALECT ?? "sqlite";
const configOf = dialect === "postgres" ? pgConfig : dialect === "mysql" ? mysqlConfig : sqliteConfig;
const out: Record<string, unknown> = {};
type Named = { name?: string };
type TableConfig = {
	name: string;
	columns: Array<{ name: string; primary: boolean; isUnique: boolean; getSQLType(): string }>;
	indexes: Array<{ config: { name: string; columns: Named[] } }>;
	uniqueConstraints?: Array<{ name?: string; columns: Named[] }>;
	foreignKeys: Array<{ reference(): { columns: Named[] } }>;
};

for (const value of Object.values(schema.schema)) {
	const config = (configOf as (table: unknown) => TableConfig)(value);
	const columns = config.columns.map((column) => ({ name: column.name, sqlType: column.getSQLType() }));
	const typeOf = (name: string) => columns.find((column) => column.name === name)?.sqlType as string | undefined;
	const bytesOf = (name: string) => {
		const type = typeOf(name) ?? "";
		const length = /\((\d+)\)/.exec(type);
		return length ? Number(length[1]) * 4 : 8;
	};
	const indexed = new Set<string>();
	const indexBytes: Record<string, number> = {};
	const track = (name: string, indexColumns: Named[]) => {
		let bytes = 0;
		for (const column of indexColumns) {
			if (column?.name) {
				indexed.add(column.name);
				bytes += bytesOf(column.name);
			}
		}
		indexBytes[name] = bytes;
	};
	for (const column of config.columns) if (column.primary || column.isUnique) indexed.add(column.name);
	for (const index of config.indexes) track(index.config.name, index.config.columns);
	for (const unique of config.uniqueConstraints ?? []) track(unique.name ?? "unique", unique.columns);
	for (const fk of config.foreignKeys) for (const column of fk.reference().columns) if (column.name) indexed.add(column.name);
	out[config.name] = { columns, indexed: [...indexed], indexBytes, indexNames: config.indexes.map((index) => index.config.name) };
}
console.log(JSON.stringify(out));

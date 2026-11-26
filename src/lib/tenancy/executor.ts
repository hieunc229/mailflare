import type { SqlExecutor, QueryResult } from "@/db/drivers/types";
import type { TenantDb } from "./tenant-db";

/**
 * Worker-side `SqlExecutor` for one tenant's Durable Object. Statements run one by one: there is no
 * `transaction`, because a transaction cannot stay open across Durable Object RPC calls, so a batch is
 * not atomic here (D1 makes it atomic). Migrations are, since the object runs those itself.
 */
interface Rpc {
	query(sql: string, params: unknown[], mode: "array" | "object"): Promise<QueryResult>;
}

export function tenantExecutor(stub: DurableObjectStub<TenantDb>): SqlExecutor {
	return {
		dialect: "sqlite",
		async query(sql, params, mode): Promise<QueryResult> {
			// Rows are plain data; Durable Object RPC typing cannot express `unknown`, so the call is typed by hand.
			const result = await (stub as unknown as Rpc).query(sql, params, mode);
			return { ...result, rows: result.rows.map((row) => fromStorage(row, mode)) };
		},
	};
}

/** BLOBs come back as ArrayBuffers; the SQLite drivers hand out Uint8Arrays. */
function fromStorage(row: unknown, mode: "array" | "object"): unknown {
	if (mode === "array") return (row as unknown[]).map((value) => (value instanceof ArrayBuffer ? new Uint8Array(value) : value));
	return Object.fromEntries(Object.entries(row as Record<string, unknown>).map(([key, value]) => [key, value instanceof ArrayBuffer ? new Uint8Array(value) : value]));
}

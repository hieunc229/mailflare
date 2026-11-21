import { eq, inArray } from "drizzle-orm";
import type { AppDatabase } from "@/db";
import { apiKeys } from "@/db/schema";
import { parseScopes } from "@/lib/api-keys";
import { ADMIN_API_KEY_SCOPES } from "@/lib/api/scopes";

const adminScopes = new Set<string>(ADMIN_API_KEY_SCOPES);

/** Statements that delete every administrative API key of `userId`, for use inside a `db.batch`. */
export async function adminApiKeyRevocations(db: AppDatabase, userId: string) {
	const rows = await db.select({ id: apiKeys.id, scopes: apiKeys.scopes }).from(apiKeys).where(eq(apiKeys.userId, userId));
	const ids = rows.filter((row) => parseScopes(row.scopes).some((scope) => adminScopes.has(scope))).map((row) => row.id);
	const statements: Array<ReturnType<ReturnType<AppDatabase["delete"]>["where"]>> = [];
	// D1 allows 100 bound parameters per statement.
	for (let offset = 0; offset < ids.length; offset += 50) {
		statements.push(db.delete(apiKeys).where(inArray(apiKeys.id, ids.slice(offset, offset + 50))));
	}
	return statements;
}

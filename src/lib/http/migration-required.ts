import { NextResponse } from "next/server";
import { isMissingColumnError, isMissingTableError } from "@/lib/database-errors";

/**
 * The answer for a request whose migration (a table or a column it reads) has not been applied
 * yet: the same body and status the deliverability and promotions routes answer with.
 */
export const MIGRATION_REQUIRED = { error: "Apply pending database migrations first", code: "MIGRATION_REQUIRED" };

/** Whether the error is one a pending migration would explain. */
export const isMigrationRequired = (error: unknown) => isMissingTableError(error) || isMissingColumnError(error);

/**
 * A database behind on migrations must say so instead of a 500 — and never read as a wrong
 * password, a disabled account or an expired passkey. Anything else is rethrown untouched.
 */
export function migrationRequired(error: unknown) {
	if (!isMigrationRequired(error)) throw error;
	return NextResponse.json(MIGRATION_REQUIRED, { status: 409 });
}

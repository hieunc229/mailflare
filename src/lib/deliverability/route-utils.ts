import { NextResponse } from "next/server";
import { isMissingColumnError, isMissingTableError } from "@/lib/database-errors";

/** The answer for a route whose migration (a table or a column it reads) has not been applied yet; anything else is rethrown. */
export function migrationRequired(error: unknown) {
	if (!isMissingTableError(error) && !isMissingColumnError(error)) throw error;
	return NextResponse.json({ error: "Apply pending database migrations first", code: "MIGRATION_REQUIRED" }, { status: 409 });
}

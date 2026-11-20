import { NextResponse } from "next/server";
import { isMissingTableError } from "@/lib/database-errors";

/** The answer for a route whose migration has not been applied yet; anything else is rethrown. */
export function migrationRequired(error: unknown) {
	if (!isMissingTableError(error)) throw error;
	return NextResponse.json({ error: "Apply pending database migrations first", code: "MIGRATION_REQUIRED" }, { status: 409 });
}

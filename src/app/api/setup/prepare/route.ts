import { NextResponse } from "next/server";
import { hasAdminAccount } from "@/lib/auth/setup";
import { requireSetupCode } from "@/lib/auth/setup-code";
import { getEnv } from "@/lib/cloudflare";
import { getSetupRequirementChecks } from "@/lib/setup/configuration";
import { migrateCleanDatabase } from "@/lib/setup/migration";

export async function POST(request: Request) {
	const env = getEnv();
	if (await hasAdminAccount(env)) {
		return NextResponse.json({ error: "Initial setup is already complete" }, { status: 403 });
	}

	const checks = getSetupRequirementChecks(env);
	if (checks.some((check) => !check.configured)) {
		return NextResponse.json({ checks, migrated: false }, { status: 503 });
	}
	// After the configuration checks, so a missing CF_TOKEN is still reported without the code.
	const denied = await requireSetupCode(env, request, { checks, migrated: false });
	if (denied) return denied;

	try {
		const migrated = await migrateCleanDatabase(env.DB);
		return NextResponse.json({ checks, migrated });
	} catch (error) {
		const message = error instanceof Error ? error.message : "Database preparation failed";
		return NextResponse.json({ checks, migrated: false, error: message }, { status: 500 });
	}
}

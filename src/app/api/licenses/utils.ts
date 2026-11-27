import { NextResponse } from "next/server";
import { z } from "zod";
import { assertPrimaryAdmin } from "@/lib/auth/admin";
import { requireUser } from "@/lib/auth/cookies";
import type { LicenseKeyRequest } from "./types";

const licenseKeySchema = z.object({
	licenseKey: z.string().trim().min(1).max(500),
	plan: z.enum(["pro", "team"]).optional(),
});

export async function requireLicenseAdmin(env: CloudflareEnv, request: Request): Promise<NextResponse | null> {
	try {
		assertPrimaryAdmin(await requireUser(env, request));
		return null;
	} catch {
		return NextResponse.json({ error: "Forbidden" }, { status: 403 });
	}
}

export async function parseLicenseKeyRequest(request: Request): Promise<LicenseKeyRequest> {
	return licenseKeySchema.parse(await request.json().catch(() => null));
}

export function getLicenseInstanceUrl(request: Request): string {
	return new URL(request.url).origin;
}

export function getLicenseErrorResponse(error: unknown): NextResponse {
	if (error instanceof z.ZodError) {
		return NextResponse.json({ error: "Enter a valid license key" }, { status: 400 });
	}
	const message = error instanceof Error ? error.message : "License request failed";
	const migrationMissing = /no such table|license_settings/i.test(message);
	return NextResponse.json(
		{ error: migrationMissing ? "Apply the latest database migration before activating a license" : message },
		{ status: migrationMissing ? 503 : 400 },
	);
}

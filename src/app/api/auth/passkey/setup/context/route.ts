import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { getEnv } from "@/lib/cloudflare";
import { getDb } from "@/db";
import { users } from "@/db/schema";
import { getEnrollmentGrant } from "@/lib/auth/webauthn/grants";
import { authError } from "@/lib/http/auth-error";

/** Shows which account an enrolment link belongs to before any browser prompt. */
export async function GET(request: Request) {
	const env = getEnv();
	const token = new URL(request.url).searchParams.get("token");
	if (!token) return authError("setup_invalid", 400);
	const grant = await getEnrollmentGrant(env, token);
	if (!grant) return authError("setup_invalid", 401);
	const [user] = await getDb(env).select({ email: users.email, name: users.name, disabled: users.disabled, deletedAt: users.deletedAt }).from(users).where(eq(users.id, grant.userId)).limit(1);
	if (!user || user.disabled || user.deletedAt) return authError("account_disabled", 403);
	return NextResponse.json(
		{ email: user.email, name: user.name, kind: grant.kind, expiresAt: grant.expiresAt.toISOString() },
		{ headers: { "Cache-Control": "no-store" } },
	);
}

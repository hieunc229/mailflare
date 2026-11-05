import { NextResponse } from "next/server";
import { getEnv } from "@/lib/cloudflare";
import { requireSessionUser } from "@/lib/api/auth";
import { readJsonBody } from "@/lib/http/request";
import { beginMfaEnrollment } from "@/lib/auth/mfa";
import { mfaEnrollSchema } from "@/lib/validators";
import { getSessionTokenFromRequestHeaders } from "@/lib/auth/session";
import { authorizeSecurityChange } from "@/lib/auth/webauthn/authorize";
import { authError } from "@/lib/http/auth-error";

/** Re-checks the password or a passkey step-up, then returns a new secret with its QR code. */
export async function POST(request: Request) {
	const env = getEnv();
	const auth = await requireSessionUser(env, request);
	if (auth.error) return authError("session_expired", 401);
	const parsed = mfaEnrollSchema.safeParse(await readJsonBody(request, 16 * 1024).catch(() => null));
	if (!parsed.success) return authError("verification_required", 400);
	if (auth.user.totpEnabled) return authError("invalid_request", 409);
	if (!(await authorizeSecurityChange(env, auth.user, getSessionTokenFromRequestHeaders(request), parsed.data, "mfa.enroll"))) {
		return authError("verification_failed", 401);
	}
	return NextResponse.json(await beginMfaEnrollment(env, auth.user), { headers: { "Cache-Control": "no-store" } });
}

import { NextResponse } from "next/server";
import { getEnv } from "@/lib/cloudflare";
import { requireSessionUser } from "@/lib/api/auth";
import { readJsonBody } from "@/lib/http/request";
import { passkeyStepUpSchema } from "@/lib/validators";
import { verifyPassword } from "@/lib/auth/password";
import { allowLoginAttempt } from "@/lib/auth/rate-limit";
import { getSessionTokenFromRequestHeaders } from "@/lib/auth/session";
import { createStepUpGrant, StaleStepUpProofError } from "@/lib/auth/webauthn/grants";
import { verifySecondFactor } from "@/lib/auth/mfa";
import { authError } from "@/lib/http/auth-error";

/** Re-authenticates the current session for one named security change. */
export async function POST(request: Request) {
	const env = getEnv();
	const auth = await requireSessionUser(env, request);
	if (auth.error) return authError("session_expired", 401);
	const expectedActorSecurityVersion = auth.user.securityVersion;
	if (!(await allowLoginAttempt(env, request))) {
		return authError("rate_limited", 429, { "Retry-After": "60" });
	}
	const parsed = passkeyStepUpSchema.safeParse(await readJsonBody(request, 16 * 1024).catch(() => null));
	if (!parsed.success) return authError("verification_required", 400);
	const { action, targetUserId } = parsed.data;
	if (targetUserId && !action.startsWith("admin.")) return authError("invalid_request", 400);
	if (action.startsWith("admin.") && auth.user.role !== "admin") return authError("verification_failed", 403);
	if (!verifyPassword(parsed.data.password, auth.user.passwordHash)) {
		return authError("password_incorrect", 400);
	}
	// A password alone is not enough when password sign-ins require a second
	// factor. Disabling the authenticator also always needs one of its codes,
	// even when the second-step policy is currently off. A passkey step-up is
	// handled by the separate assertion route.
	const actionRequiresCode = auth.user.requireSecondFactor || (action === "mfa.disable" && auth.user.totpEnabled);
	if (actionRequiresCode) {
		if (!parsed.data.code) return authError("verification_required", 401);
		if (!(await verifySecondFactor(env, auth.user, parsed.data.code))) {
			return authError("code_mismatch", 401);
		}
	}
	const token = getSessionTokenFromRequestHeaders(request);
	if (!token) return authError("session_expired", 401);
	try {
		return NextResponse.json(
			{ stepUpToken: await createStepUpGrant(env, {
				userId: auth.user.id,
				sessionToken: token,
				action,
				targetUserId,
				expectedActorSecurityVersion,
			}) },
			{ headers: { "Cache-Control": "no-store" } },
		);
	} catch (error) {
		if (error instanceof StaleStepUpProofError) return authError("verification_required", 409);
		return authError("invalid_request", 400);
	}
}

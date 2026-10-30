import { NextResponse } from "next/server";
import { getEnv } from "@/lib/cloudflare";
import { requireSessionUser } from "@/lib/api/auth";
import { readJsonBody } from "@/lib/http/request";
import { getDb } from "@/db";
import { issueRecoveryCodes } from "@/lib/auth/recovery-codes";
import { mfaEnrollSchema } from "@/lib/validators";
import { getSessionTokenFromRequestHeaders } from "@/lib/auth/session";
import { authorizeSecurityChange } from "@/lib/auth/webauthn/authorize";
import { bumpSecurityVersion } from "@/lib/auth/webauthn/grants";
import { authError } from "@/lib/http/auth-error";

/** Replaces authenticator-app recovery codes; the old ones stop working immediately. */
export async function POST(request: Request) {
	const env = getEnv();
	const auth = await requireSessionUser(env, request);
	if (auth.error) return authError("session_expired", 401);
	const parsed = mfaEnrollSchema.safeParse(await readJsonBody(request, 16 * 1024).catch(() => null));
	if (!parsed.success) return authError("verification_required", 400);
	if (!auth.user.totpEnabled) return authError("invalid_request", 409);
	if (!(await authorizeSecurityChange(env, auth.user, getSessionTokenFromRequestHeaders(request), parsed.data, "mfa.codes"))) {
		return authError("verification_failed", 401);
	}
	const recoveryCodes = await issueRecoveryCodes(env, auth.user.id);
	await bumpSecurityVersion(getDb(env), auth.user.id);
	return NextResponse.json({ recoveryCodes }, { headers: { "Cache-Control": "no-store" } });
}

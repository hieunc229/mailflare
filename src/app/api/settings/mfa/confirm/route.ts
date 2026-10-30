import { NextResponse } from "next/server";
import { getEnv } from "@/lib/cloudflare";
import { requireSessionUser } from "@/lib/api/auth";
import { readJsonBody } from "@/lib/http/request";
import { getDb } from "@/db";
import { getSessionTokenFromRequestHeaders } from "@/lib/auth/session";
import { confirmMfaEnrollment } from "@/lib/auth/mfa";
import { mfaConfirmSchema } from "@/lib/validators";
import { bumpSecurityVersion } from "@/lib/auth/webauthn/grants";
import { authError } from "@/lib/http/auth-error";

/** Proves the authenticator has the secret; turns MFA on and returns recovery codes once. */
export async function POST(request: Request) {
	const env = getEnv();
	const auth = await requireSessionUser(env, request);
	if (auth.error) return authError("session_expired", 401);
	const parsed = mfaConfirmSchema.safeParse(await readJsonBody(request, 16 * 1024).catch(() => null));
	if (!parsed.success) return authError("code_mismatch", 400);
	const result = await confirmMfaEnrollment(env, auth.user, parsed.data.code, getSessionTokenFromRequestHeaders(request));
	if (!result.ok) return authError("code_mismatch", 400);
	await bumpSecurityVersion(getDb(env), auth.user.id);
	return NextResponse.json({ ok: true, recoveryCodes: result.recoveryCodes }, { headers: { "Cache-Control": "no-store" } });
}

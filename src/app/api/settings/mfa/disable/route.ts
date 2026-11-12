import { NextResponse } from "next/server";
import { getEnv } from "@/lib/cloudflare";
import { requireSessionUser } from "@/lib/api/auth";
import { readJsonBody } from "@/lib/http/request";
import { getDb } from "@/db";
import { disableMfa } from "@/lib/auth/mfa";
import { mfaDisableSchema } from "@/lib/validators";
import { getSessionTokenFromRequestHeaders } from "@/lib/auth/session";
import { authorizeSecurityChange } from "@/lib/auth/webauthn/authorize";
import { bumpSecurityVersion } from "@/lib/auth/webauthn/grants";
import { authError } from "@/lib/http/auth-error";

/** Turning MFA off needs a fresh proof, so a stolen session alone cannot do it. */
export async function POST(request: Request) {
	const env = getEnv();
	const auth = await requireSessionUser(env, request);
	if (auth.error) return authError("session_expired", 401);
	const parsed = mfaDisableSchema.safeParse(await readJsonBody(request, 16 * 1024).catch(() => null));
	if (!parsed.success) return authError("verification_required", 400);
	// The password path must always present a current authenticator or recovery
	// code. A step-up grant already proves the required factor(s).
	if (!(await authorizeSecurityChange(env, auth.user, getSessionTokenFromRequestHeaders(request), parsed.data, "mfa.disable", { requireCode: true }))) {
		return authError("verification_failed", 401);
	}
	await disableMfa(env, auth.user.id);
	await bumpSecurityVersion(getDb(env), auth.user.id);
	return NextResponse.json({ ok: true });
}

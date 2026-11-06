import { NextResponse } from "next/server";
import { getEnv } from "@/lib/cloudflare";
import { requireSessionUser } from "@/lib/api/auth";
import { readJsonBody } from "@/lib/http/request";
import { passkeyStepUpVerifySchema } from "@/lib/validators";
import { allowLoginAttempt } from "@/lib/auth/rate-limit";
import { getSessionTokenFromRequestHeaders } from "@/lib/auth/session";
import { consumeWebAuthnChallenge, readCeremonyBindings, removeCeremonyCookie } from "@/lib/auth/webauthn/challenges";
import { isAuthenticationResponseJSON, verifyPasskeyAuthentication } from "@/lib/auth/webauthn/service";
import { createStepUpGrant, StaleStepUpProofError } from "@/lib/auth/webauthn/grants";
import { authError } from "@/lib/http/auth-error";
import { PasskeyVerificationError } from "@/lib/auth/webauthn/errors";

export async function POST(request: Request) {
	const env = getEnv();
	const auth = await requireSessionUser(env, request);
	if (auth.error) return authError("session_expired", 401);
	const expectedActorSecurityVersion = auth.user.securityVersion;
	if (!(await allowLoginAttempt(env, request))) {
		return authError("rate_limited", 429, { "Retry-After": "60" });
	}
	const parsed = passkeyStepUpVerifySchema.safeParse(await readJsonBody(request, 64 * 1024).catch(() => null));
	if (!parsed.success || !isAuthenticationResponseJSON(parsed.data.response)) {
		return authError("passkey_invalid", 400);
	}
	const sessionToken = getSessionTokenFromRequestHeaders(request);
	const bindings = readCeremonyBindings(request);
	const prefix = `step-up:${parsed.data.action}:${parsed.data.targetUserId ?? "-"}:`;
	const matching = bindings.filter((binding) => binding.startsWith(prefix));
	if (!sessionToken || matching.length === 0) return authError("passkey_expired", 401);
	const challenge = await consumeWebAuthnChallenge(env, {
		ceremonyToken: parsed.data.ceremonyToken,
		purpose: "step_up",
		bindings: matching,
	});
	if (!challenge || challenge.userId !== auth.user.id) {
		return authError("passkey_expired", 401);
	}
	try {
		await verifyPasskeyAuthentication(env, request, parsed.data.response, challenge.challenge, { expectedUser: auth.user });
		let token: string;
		try {
			token = await createStepUpGrant(env, {
				userId: auth.user.id,
				sessionToken,
				action: parsed.data.action,
				targetUserId: parsed.data.targetUserId,
				expectedActorSecurityVersion,
			});
		} catch (error) {
			const response = error instanceof StaleStepUpProofError
				? authError("verification_required", 409)
				: authError("invalid_request", 400);
			removeCeremonyCookie(response.headers, request, challenge.binding);
			return response;
		}
		const response = NextResponse.json({ stepUpToken: token }, { headers: { "Cache-Control": "no-store" } });
		removeCeremonyCookie(response.headers, request, challenge.binding);
		return response;
	} catch (error) {
		const response = authError(error instanceof PasskeyVerificationError ? error.code : "passkey_invalid", 401);
		removeCeremonyCookie(response.headers, request, challenge.binding);
		return response;
	}
}

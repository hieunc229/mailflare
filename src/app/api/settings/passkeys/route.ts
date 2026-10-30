import { getEnv } from "@/lib/cloudflare";
import { requireSessionUser } from "@/lib/api/auth";
import { readJsonBody } from "@/lib/http/request";
import { passkeyRegistrationSchema } from "@/lib/validators";
import { getSessionTokenFromRequestHeaders } from "@/lib/auth/session";
import { bumpSecurityVersion, consumeStepUpGrant } from "@/lib/auth/webauthn/grants";
import { consumeWebAuthnChallenge, readCeremonyBindings, removeCeremonyCookie } from "@/lib/auth/webauthn/challenges";
import { isRegistrationResponseJSON, verifyPasskeyRegistration } from "@/lib/auth/webauthn/service";
import { recordAuthActivity } from "@/lib/auth/activity";
import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { authError, isUniqueCredentialError } from "@/lib/http/auth-error";
import { PasskeyVerificationError } from "@/lib/auth/webauthn/errors";

export async function POST(request: Request) {
	const env = getEnv();
	const auth = await requireSessionUser(env, request);
	if (auth.error) return auth.error;
	const parsed = passkeyRegistrationSchema.safeParse(await readJsonBody(request, 64 * 1024).catch(() => null));
	if (!parsed.success || !parsed.data.stepUpToken || !isRegistrationResponseJSON(parsed.data.response)) {
		return authError("verification_required", 400);
	}
	const sessionToken = getSessionTokenFromRequestHeaders(request);
	const bindings = readCeremonyBindings(request);
	if (!sessionToken || bindings.length === 0) return authError("passkey_expired", 401);
	if (!(await consumeStepUpGrant(env, {
		token: parsed.data.stepUpToken,
		userId: auth.user.id,
		sessionToken,
		action: "passkey.add",
	}))) {
		return authError("verification_required", 401);
	}
	const challenge = await consumeWebAuthnChallenge(env, {
		ceremonyToken: parsed.data.ceremonyToken,
		purpose: "register",
		bindings,
	});
	if (!challenge || challenge.userId !== auth.user.id) {
		return authError("passkey_expired", 401);
	}
	try {
		const { passkey } = await verifyPasskeyRegistration(env, request, parsed.data.response, challenge.challenge, auth.user, parsed.data.name);
		await bumpSecurityVersion(getDb(env), auth.user.id);
		await recordAuthActivity(env, { action: "auth.passkey_added", userId: auth.user.id, request });
		const response = NextResponse.json({
			ok: true,
			passkey: { id: passkey.id, name: passkey.name, createdAt: passkey.createdAt.toISOString() },
		});
		removeCeremonyCookie(response.headers, request, challenge.binding);
		return response;
	} catch (error) {
		const unique = isUniqueCredentialError(error);
		const code = unique ? "passkey_already_registered" : error instanceof PasskeyVerificationError ? error.code : "passkey_invalid";
		const response = authError(code, unique ? 409 : 400);
		removeCeremonyCookie(response.headers, request, challenge.binding);
		return response;
	}
}

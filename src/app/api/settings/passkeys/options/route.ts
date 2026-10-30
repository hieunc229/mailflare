import { NextResponse } from "next/server";
import { getEnv } from "@/lib/cloudflare";
import { requireSessionUser } from "@/lib/api/auth";
import { readJsonBody } from "@/lib/http/request";
import { passkeyAddOptionsSchema } from "@/lib/validators";
import { getSessionTokenFromRequestHeaders } from "@/lib/auth/session";
import { listPasskeys } from "@/lib/auth/webauthn/credentials";
import { createRegistrationOptions } from "@/lib/auth/webauthn/service";
import { peekStepUpGrant } from "@/lib/auth/webauthn/grants";
import {
	createCeremonyBinding,
	createWebAuthnChallenge,
	readCeremonyBindings,
	setCeremonyCookie,
} from "@/lib/auth/webauthn/challenges";
import { webAuthnUnavailableCode } from "@/lib/auth/webauthn/errors";
import { authError } from "@/lib/http/auth-error";

/**
 * Options for adding a passkey to the signed-in account. The grant is checked
 * before opening the browser prompt, then consumed when creation completes.
 */
export async function POST(request: Request) {
	const env = getEnv();
	const auth = await requireSessionUser(env, request);
	if (auth.error) return auth.error;
	const parsed = passkeyAddOptionsSchema.safeParse(await readJsonBody(request, 16 * 1024).catch(() => null));
	const sessionToken = getSessionTokenFromRequestHeaders(request);
	if (!parsed.success || !sessionToken) return authError("verification_required", 400);
	if (!(await peekStepUpGrant(env, {
		token: parsed.data.stepUpToken,
		userId: auth.user.id,
		sessionToken,
		action: "passkey.add",
	}))) {
		return authError("verification_required", 401);
	}
	try {
		const existing = await listPasskeys(env, auth.user.id);
		const { options } = await createRegistrationOptions(env, request, auth.user, existing);
		const binding = createCeremonyBinding();
		const { ceremonyToken } = await createWebAuthnChallenge(env, {
			challenge: options.challenge,
			purpose: "register",
			userId: auth.user.id,
			binding,
		});
		const response = NextResponse.json({ options, ceremonyToken });
		response.headers.set("Cache-Control", "no-store");
		setCeremonyCookie(response.headers, binding, readCeremonyBindings(request));
		return response;
	} catch (error) {
		return authError(webAuthnUnavailableCode(error), 503);
	}
}

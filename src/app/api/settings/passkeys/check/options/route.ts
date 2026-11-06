import { NextResponse } from "next/server";
import { getEnv } from "@/lib/cloudflare";
import { requireSessionUser } from "@/lib/api/auth";
import { listPasskeys } from "@/lib/auth/webauthn/credentials";
import { createAuthenticationOptions } from "@/lib/auth/webauthn/service";
import {
	createCeremonyBinding,
	createWebAuthnChallenge,
	readCeremonyBindings,
	setCeremonyCookie,
} from "@/lib/auth/webauthn/challenges";
import { webAuthnUnavailableCode } from "@/lib/auth/webauthn/errors";
import { authError } from "@/lib/http/auth-error";

/**
 * Starts a passkey check restricted to the signed-in account. A successful
 * assertion only identifies the credential; it grants no security change.
 */
export async function POST(request: Request) {
	const env = getEnv();
	const auth = await requireSessionUser(env, request);
	if (auth.error) return auth.error;
	const passkeys = await listPasskeys(env, auth.user.id);
	if (passkeys.length === 0) return authError("passkey_not_found", 400);
	try {
		const { options } = await createAuthenticationOptions(env, request, passkeys);
		const binding = `check:${createCeremonyBinding()}`;
		const { ceremonyToken } = await createWebAuthnChallenge(env, {
			challenge: options.challenge,
			purpose: "check",
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

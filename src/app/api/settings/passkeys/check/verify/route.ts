import { NextResponse } from "next/server";
import { getEnv } from "@/lib/cloudflare";
import { requireSessionUser } from "@/lib/api/auth";
import { readJsonBody } from "@/lib/http/request";
import { passkeyCeremonySchema } from "@/lib/validators";
import { consumeWebAuthnChallenge, readCeremonyBindings, removeCeremonyCookie } from "@/lib/auth/webauthn/challenges";
import { isAuthenticationResponseJSON, verifyPasskeyAuthentication } from "@/lib/auth/webauthn/service";
import { authError } from "@/lib/http/auth-error";
import { PasskeyVerificationError } from "@/lib/auth/webauthn/errors";

/** Identifies which saved passkey the browser recognized, without signing in. */
export async function POST(request: Request) {
	const env = getEnv();
	const auth = await requireSessionUser(env, request);
	if (auth.error) return auth.error;
	const parsed = passkeyCeremonySchema.safeParse(await readJsonBody(request, 64 * 1024).catch(() => null));
	if (!parsed.success || !isAuthenticationResponseJSON(parsed.data.response)) {
		return authError("passkey_invalid", 400);
	}
	const bindings = readCeremonyBindings(request);
	if (bindings.length === 0) return authError("passkey_expired", 401);
	const challenge = await consumeWebAuthnChallenge(env, {
		ceremonyToken: parsed.data.ceremonyToken,
		purpose: "check",
		bindings,
	});
	if (!challenge || challenge.userId !== auth.user.id) {
		return authError("passkey_expired", 401);
	}
	try {
		const { passkey } = await verifyPasskeyAuthentication(env, request, parsed.data.response, challenge.challenge, {
			expectedUser: auth.user,
		});
		const response = NextResponse.json({ ok: true, passkeyId: passkey.id }, { headers: { "Cache-Control": "no-store" } });
		removeCeremonyCookie(response.headers, request, challenge.binding);
		return response;
	} catch (error) {
		const response = authError(error instanceof PasskeyVerificationError ? error.code : "passkey_invalid", 401);
		removeCeremonyCookie(response.headers, request, challenge.binding);
		return response;
	}
}

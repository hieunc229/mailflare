import { getEnv } from "@/lib/cloudflare";
import { allowLoginAttempt } from "@/lib/auth/rate-limit";
import { readJsonBody } from "@/lib/http/request";
import { RequestBodyTooLargeError } from "@/lib/http/errors";
import { passkeyCeremonySchema } from "@/lib/validators";
import {
	consumeWebAuthnChallenge,
	readCeremonyBindings,
	removeCeremonyCookie,
} from "@/lib/auth/webauthn/challenges";
import { isAuthenticationResponseJSON, verifyPasskeyAuthentication } from "@/lib/auth/webauthn/service";
import { completeLogin } from "@/lib/auth/login-response";
import { recordAuthActivity } from "@/lib/auth/activity";
import { authError } from "@/lib/http/auth-error";
import { PasskeyVerificationError } from "@/lib/auth/webauthn/errors";

/** Completes a discoverable passkey sign-in. */
export async function POST(request: Request) {
	const env = getEnv();
	let body: unknown;
	try {
		body = await readJsonBody(request, 64 * 1024);
	} catch (error) {
		const status = error instanceof RequestBodyTooLargeError ? 413 : 400;
		return authError("invalid_request", status);
	}
	if (!(await allowLoginAttempt(env, request))) {
		return authError("rate_limited", 429, { "Retry-After": "60" });
	}
	const parsed = passkeyCeremonySchema.safeParse(body);
	if (!parsed.success || !isAuthenticationResponseJSON(parsed.data.response)) {
		return authError("passkey_invalid", 400);
	}
	const bindings = readCeremonyBindings(request);
	if (bindings.length === 0) return authError("passkey_expired", 401);

	const challenge = await consumeWebAuthnChallenge(env, {
		ceremonyToken: parsed.data.ceremonyToken,
		purpose: "login",
		bindings,
	});
	if (!challenge) return authError("passkey_expired", 401);

	try {
		const { passkey } = await verifyPasskeyAuthentication(env, request, parsed.data.response, challenge.challenge, { requireUserHandle: true });
		const response = await completeLogin(env, request, passkey.userId, { activity: "auth.passkey_verified", body: { method: "passkey" } });
		await recordAuthActivity(env, { action: "auth.login", userId: passkey.userId, request });
		removeCeremonyCookie(response.headers, request, challenge.binding);
		return response;
	} catch (error) {
		const response = authError(error instanceof PasskeyVerificationError ? error.code : "passkey_invalid", 401);
		removeCeremonyCookie(response.headers, request, challenge.binding);
		return response;
	}
}

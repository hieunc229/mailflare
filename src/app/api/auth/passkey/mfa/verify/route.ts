import { eq } from "drizzle-orm";
import { getEnv } from "@/lib/cloudflare";
import { getDb } from "@/db";
import { users } from "@/db/schema";
import { allowLoginAttempt } from "@/lib/auth/rate-limit";
import { readJsonBody } from "@/lib/http/request";
import { RequestBodyTooLargeError } from "@/lib/http/errors";
import { passkeyMfaVerifySchema } from "@/lib/validators";
import { consumeLoginChallenge, getLoginChallengeUserId } from "@/lib/auth/login-challenge";
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

/** Finishes a password + passkey sign-in. */
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
	const parsed = passkeyMfaVerifySchema.safeParse(body);
	if (!parsed.success || !isAuthenticationResponseJSON(parsed.data.response)) {
		return authError("passkey_invalid", 400);
	}
	const bindings = readCeremonyBindings(request);
	const binding = bindings.find((candidate) => candidate.endsWith(`:${parsed.data.challengeToken}`));
	if (!binding) return authError("passkey_expired", 401);
	const userId = await getLoginChallengeUserId(env, parsed.data.challengeToken);
	if (!userId) return authError("passkey_expired", 401);
	const [user] = await getDb(env).select().from(users).where(eq(users.id, userId)).limit(1);
	if (!user || user.disabled || user.deletedAt) return authError("account_disabled", 403);

	const challenge = await consumeWebAuthnChallenge(env, {
		ceremonyToken: parsed.data.ceremonyToken,
		purpose: "mfa",
		bindings,
	});
	if (!challenge || challenge.userId !== user.id) {
		return authError("passkey_expired", 401);
	}

	try {
		await verifyPasskeyAuthentication(env, request, parsed.data.response, challenge.challenge, { expectedUser: user });
		if (!(await consumeLoginChallenge(env, parsed.data.challengeToken))) {
			return authError("passkey_expired", 401);
		}
		const response = await completeLogin(env, request, user.id, { activity: "auth.passkey_verified", body: { method: "passkey" } });
		await recordAuthActivity(env, { action: "auth.mfa_verified", userId: user.id, request });
		removeCeremonyCookie(response.headers, request, challenge.binding);
		return response;
	} catch (error) {
		const response = authError(error instanceof PasskeyVerificationError ? error.code : "passkey_invalid", 401);
		removeCeremonyCookie(response.headers, request, challenge.binding);
		return response;
	}
}

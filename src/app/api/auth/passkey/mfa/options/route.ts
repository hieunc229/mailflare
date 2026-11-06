import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { getEnv } from "@/lib/cloudflare";
import { getDb } from "@/db";
import { users } from "@/db/schema";
import { allowLoginAttempt } from "@/lib/auth/rate-limit";
import { readJsonBody } from "@/lib/http/request";
import { passkeyMfaOptionsSchema } from "@/lib/validators";
import { getLoginChallengeUserId } from "@/lib/auth/login-challenge";
import { listPasskeys } from "@/lib/auth/webauthn/credentials";
import { createAuthenticationOptions } from "@/lib/auth/webauthn/service";
import {
	createCeremonyBinding,
	createWebAuthnChallenge,
	readCeremonyBindings,
	setCeremonyCookie,
} from "@/lib/auth/webauthn/challenges";
import { authError } from "@/lib/http/auth-error";

/** Starts the passkey alternative to a TOTP prompt after a password sign-in. */
export async function POST(request: Request) {
	const env = getEnv();
	if (!(await allowLoginAttempt(env, request))) {
		return authError("rate_limited", 429, { "Retry-After": "60" });
	}
	const parsed = passkeyMfaOptionsSchema.safeParse(await readJsonBody(request, 16 * 1024).catch(() => null));
	if (!parsed.success) return authError("invalid_request", 400);

	const userId = await getLoginChallengeUserId(env, parsed.data.challengeToken);
	if (!userId) return authError("passkey_expired", 401);
	const [user] = await getDb(env).select().from(users).where(eq(users.id, userId)).limit(1);
	if (!user || user.disabled || user.deletedAt) return authError("account_disabled", 403);
	const passkeys = await listPasskeys(env, user.id);
	if (passkeys.length === 0) return authError("passkey_not_found", 400);

	try {
		const { options } = await createAuthenticationOptions(env, request, passkeys);
		const binding = `${createCeremonyBinding()}:${parsed.data.challengeToken}`;
		const { ceremonyToken } = await createWebAuthnChallenge(env, {
			challenge: options.challenge,
			purpose: "mfa",
			userId: user.id,
			binding,
		});
		const response = NextResponse.json({ options, ceremonyToken });
		response.headers.set("Cache-Control", "no-store");
		setCeremonyCookie(response.headers, binding, readCeremonyBindings(request));
		return response;
	} catch {
		return authError("passkey_unavailable", 503);
	}
}

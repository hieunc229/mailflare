import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { getEnv } from "@/lib/cloudflare";
import { getDb } from "@/db";
import { users } from "@/db/schema";
import { readJsonBody } from "@/lib/http/request";
import { passkeySetupOptionsSchema } from "@/lib/validators";
import { getEnrollmentGrant } from "@/lib/auth/webauthn/grants";
import { listPasskeys } from "@/lib/auth/webauthn/credentials";
import { createRegistrationOptions } from "@/lib/auth/webauthn/service";
import {
	createCeremonyBinding,
	createWebAuthnChallenge,
	readCeremonyBindings,
	setCeremonyCookie,
} from "@/lib/auth/webauthn/challenges";
import { webAuthnUnavailableCode } from "@/lib/auth/webauthn/errors";
import { authError } from "@/lib/http/auth-error";

/**
 * Registration options for an enrolment grant. The grant, not a session, is
 * the authority here: first-run setup and administrator recovery both use it.
 */
export async function POST(request: Request) {
	const env = getEnv();
	const parsed = passkeySetupOptionsSchema.safeParse(await readJsonBody(request, 16 * 1024).catch(() => null));
	if (!parsed.success) return authError("setup_invalid", 400);
	const grant = await getEnrollmentGrant(env, parsed.data.token);
	if (!grant) return authError("setup_invalid", 401);
	const [user] = await getDb(env).select().from(users).where(eq(users.id, grant.userId)).limit(1);
	if (!user || user.disabled || user.deletedAt) return authError("account_disabled", 403);

	try {
		// Recovery deliberately allows the same authenticator to register again:
		// its old credential is about to be replaced, not kept alongside.
		const existing = grant.kind === "setup" ? await listPasskeys(env, user.id) : [];
		const { options } = await createRegistrationOptions(env, request, user, existing);
		const binding = createCeremonyBinding();
		const { ceremonyToken } = await createWebAuthnChallenge(env, {
			challenge: options.challenge,
			purpose: grant.kind === "setup" ? "enroll" : "recovery",
			userId: user.id,
			binding,
		});
		const response = NextResponse.json({ options, ceremonyToken, email: user.email });
		response.headers.set("Cache-Control", "no-store");
		setCeremonyCookie(response.headers, binding, readCeremonyBindings(request));
		return response;
	} catch (error) {
		return authError(webAuthnUnavailableCode(error), 503);
	}
}

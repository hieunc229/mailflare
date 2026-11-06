import { NextResponse } from "next/server";
import { getEnv } from "@/lib/cloudflare";
import { requireSessionUser } from "@/lib/api/auth";
import { allowLoginAttempt } from "@/lib/auth/rate-limit";
import { readJsonBody } from "@/lib/http/request";
import { passkeyStepUpOptionsSchema } from "@/lib/validators";
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

/** Starts a passkey re-authentication for one named security action. */
export async function POST(request: Request) {
	const env = getEnv();
	const auth = await requireSessionUser(env, request);
	if (auth.error) return authError("session_expired", 401);
	if (!(await allowLoginAttempt(env, request))) {
		return authError("rate_limited", 429, { "Retry-After": "60" });
	}
	const parsed = passkeyStepUpOptionsSchema.safeParse(await readJsonBody(request, 16 * 1024).catch(() => null));
	if (!parsed.success) return authError("invalid_request", 400);
	if (parsed.data.targetUserId && !parsed.data.action.startsWith("admin.")) return authError("invalid_request", 400);
	if (parsed.data.action.startsWith("admin.") && auth.user.role !== "admin") return authError("verification_failed", 403);
	const passkeys = await listPasskeys(env, auth.user.id);
	if (passkeys.length === 0) return authError("passkey_not_found", 400);
	try {
		const { options } = await createAuthenticationOptions(env, request, passkeys);
		const binding = `step-up:${parsed.data.action}:${parsed.data.targetUserId ?? "-"}:${createCeremonyBinding()}`;
		const { ceremonyToken } = await createWebAuthnChallenge(env, { challenge: options.challenge, purpose: "step_up", userId: auth.user.id, binding });
		const response = NextResponse.json({ options, ceremonyToken });
		response.headers.set("Cache-Control", "no-store");
		setCeremonyCookie(response.headers, binding, readCeremonyBindings(request));
		return response;
	} catch (error) {
		return authError(webAuthnUnavailableCode(error), 503);
	}
}

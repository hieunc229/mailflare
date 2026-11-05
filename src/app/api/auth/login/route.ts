import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { getEnv } from "@/lib/cloudflare";
import { getDb } from "@/db";
import { users } from "@/db/schema";
import { verifyPassword } from "@/lib/auth/password";
import { loginSchema } from "@/lib/validators";
import { allowLoginAttempt } from "@/lib/auth/rate-limit";
import { verifyTurnstileToken } from "@/lib/auth/turnstile";
import { readJsonBody } from "@/lib/http/request";
import { RequestBodyTooLargeError } from "@/lib/http/errors";
import { createLoginChallenge } from "@/lib/auth/login-challenge";
import { completeLogin } from "@/lib/auth/login-response";
import { countPasskeys } from "@/lib/auth/webauthn/credentials";
import { countUnusedRecoveryCodes } from "@/lib/auth/recovery-codes";
import { authError } from "@/lib/http/auth-error";

export async function POST(request: Request) {
	const env = getEnv();
	let body: unknown;
	try {
		body = await readJsonBody(request, 16 * 1024);
	} catch (error) {
		const status = error instanceof RequestBodyTooLargeError ? 413 : 400;
		return authError("invalid_request", status);
	}
	const parsed = loginSchema.safeParse(body);
	if (!parsed.success) return authError("invalid_request", 400);
	if (!(await allowLoginAttempt(env, request))) {
		return authError("rate_limited", 429, { "Retry-After": "60" });
	}
	if (!(await verifyTurnstileToken(env, request, (body as Record<string, unknown>).turnstileToken))) {
		return authError("verification_failed", 400);
	}

	const db = getDb(env);
	const [user] = await db.select().from(users).where(eq(users.email, parsed.data.email)).limit(1);
	// A passwordless account has no usable password; it still takes the same
	// generic error so the response cannot be used to enumerate accounts.
	if (!user || !verifyPassword(parsed.data.password, user.passwordHash)) {
		return authError("invalid_credentials", 401);
	}
	if (user.disabled || user.deletedAt) return authError("account_disabled", 403);

	// The password is right but this account requires a second factor: hand
	// back a short-lived challenge instead of a session.
	if (user.requireSecondFactor) {
		const [passkeys, recoveryCodes] = await Promise.all([
			countPasskeys(env, user.id),
			countUnusedRecoveryCodes(env, user.id),
		]);
		const methods = [
			...(passkeys > 0 ? ["passkey"] : []),
			...(user.totpEnabled && user.totpSecret ? ["totp"] : []),
			...(user.totpEnabled && recoveryCodes > 0 ? ["recovery"] : []),
		];
		if (methods.length === 0) return authError("verification_required", 409);
		const challengeToken = await createLoginChallenge(env, user.id);
		const pending = NextResponse.json({ ok: true, mfaRequired: true, challengeToken, methods });
		pending.headers.set("Cache-Control", "no-store");
		return pending;
	}

	return completeLogin(env, request, user.id);
}

import { eq } from "drizzle-orm";
import { getEnv } from "@/lib/cloudflare";
import { getDb } from "@/db";
import { users } from "@/db/schema";
import { mfaVerifySchema } from "@/lib/validators";
import { allowLoginAttempt } from "@/lib/auth/rate-limit";
import { readJsonBody } from "@/lib/http/request";
import { RequestBodyTooLargeError } from "@/lib/http/errors";
import { recordAuthActivity } from "@/lib/auth/activity";
import { consumeLoginChallenge, getLoginChallengeUserId } from "@/lib/auth/login-challenge";
import { verifySecondFactor } from "@/lib/auth/mfa";
import { completeLogin } from "@/lib/auth/login-response";
import { authError } from "@/lib/http/auth-error";

/** Second step of a login: trade a challenge plus a TOTP or recovery code for a session. */
export async function POST(request: Request) {
	const env = getEnv();
	let body: unknown;
	try {
		body = await readJsonBody(request, 16 * 1024);
	} catch (error) {
		const status = error instanceof RequestBodyTooLargeError ? 413 : 400;
		return authError("invalid_request", status);
	}
	const parsed = mfaVerifySchema.safeParse(body);
	if (!parsed.success) return authError("invalid_request", 400);
	// Codes are six digits; the login limiter is what stops brute force.
	if (!(await allowLoginAttempt(env, request))) {
		return authError("rate_limited", 429, { "Retry-After": "60" });
	}

	const userId = await getLoginChallengeUserId(env, parsed.data.challengeToken);
	if (!userId) return authError("passkey_expired", 401);
	const db = getDb(env);
	const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
	if (!user || user.disabled || user.deletedAt) return authError("account_disabled", 403);
	const method = await verifySecondFactor(env, user, parsed.data.code);
	if (!method) return authError("code_mismatch", 401);
	if (!(await consumeLoginChallenge(env, parsed.data.challengeToken))) {
		return authError("passkey_expired", 401);
	}

	// The factor is proven; the single challenge is burned so a replay cannot
	// mint a second session.
	const response = await completeLogin(env, request, user.id, { body: { method } });
	await recordAuthActivity(env, { action: "auth.mfa_verified", userId: user.id, request });
	return response;
}

import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { getEnv } from "@/lib/cloudflare";
import { getDb } from "@/db";
import { users } from "@/db/schema";
import { verifyPassword } from "@/lib/auth/password";
import { deviceLoginSchema } from "@/lib/validators";
import { allowDeviceLoginAttempt } from "@/lib/auth/rate-limit";
import { readJsonBody } from "@/lib/http/request";
import { RequestBodyTooLargeError } from "@/lib/http/errors";
import { recordAuthActivity } from "@/lib/auth/activity";
import { consumeLoginChallenge, createLoginChallenge, getLoginChallengeUserId } from "@/lib/auth/login-challenge";
import { verifySecondFactor } from "@/lib/auth/mfa";
import { countUnusedRecoveryCodes } from "@/lib/auth/recovery-codes";
import { createDeviceKey, revokeDeviceKey } from "@/lib/auth/device-keys";
import { authenticateApiRequest } from "@/lib/api/key-auth";

function json(body: unknown, status = 200, headers: Record<string, string> = {}) {
	return NextResponse.json(body, { status, headers: { "Cache-Control": "no-store", ...headers } });
}

/**
 * Mobile sign-in with the account password. Answers with a `jmap`-scoped
 * device key (shown under Settings → Devices, revocable) instead of a session.
 * With MFA on, the first call returns `{ mfaRequired, challengeToken }` and a
 * second call with `{ challengeToken, code, deviceName }` finishes.
 */
export async function POST(request: Request) {
	const env = getEnv();
	let body: unknown;
	try {
		body = await readJsonBody(request, 16 * 1024);
	} catch (error) {
		return json({ error: "Invalid sign-in request" }, error instanceof RequestBodyTooLargeError ? 413 : 400);
	}
	const parsed = deviceLoginSchema.safeParse(body);
	if (!parsed.success) return json({ error: "Invalid sign-in request" }, 400);
	if (!(await allowDeviceLoginAttempt(env, request))) {
		return json({ error: "Too many sign-in attempts. Try again shortly." }, 429, { "Retry-After": "60" });
	}

	const db = getDb(env);
	let userId: string;
	if ("password" in parsed.data) {
		const [user] = await db.select().from(users).where(eq(users.email, parsed.data.email)).limit(1);
		if (!user || !verifyPassword(parsed.data.password, user.passwordHash)) return json({ error: "Invalid credentials" }, 401);
		if (user.disabled || user.deletedAt) return json({ error: "Account disabled" }, 403);
		if (user.requireSecondFactor) {
			// The app can only finish with TOTP or a recovery code. Without one of
			// those, point the user at an app password rather than issuing a key
			// after the password alone.
			const codesAvailable = user.totpEnabled && (await countUnusedRecoveryCodes(env, user.id)) > 0;
			if (!(user.totpEnabled && user.totpSecret) && !codesAvailable) {
				return json({ error: "This account requires a passkey. Create an app password in the web app instead." }, 403);
			}
			return json({ ok: true, mfaRequired: true, challengeToken: await createLoginChallenge(env, user.id) });
		}
		userId = user.id;
	} else {
		const challengeUserId = await getLoginChallengeUserId(env, parsed.data.challengeToken);
		if (!challengeUserId) return json({ error: "This sign-in attempt has expired. Start again." }, 401);
		const [user] = await db.select().from(users).where(eq(users.id, challengeUserId)).limit(1);
		if (!user || user.disabled || user.deletedAt) return json({ error: "Account disabled" }, 403);
		if (!(await verifySecondFactor(env, user, parsed.data.code))) return json({ error: "That code did not match" }, 401);
		if (!(await consumeLoginChallenge(env, parsed.data.challengeToken))) {
			return json({ error: "This sign-in attempt has expired. Start again." }, 401);
		}
		userId = user.id;
	}

	const [user] = await db.select({ email: users.email }).from(users).where(eq(users.id, userId)).limit(1);
	const device = await createDeviceKey(env, userId, parsed.data.deviceName);
	await recordAuthActivity(env, { action: "auth.device_login", userId, request });
	const origin = env.APP_URL?.trim().replace(/\/+$/, "") || new URL(request.url).origin;
	return json({ ok: true, key: device.key, keyId: device.id, email: user?.email, sessionUrl: `${origin}/jmap/session` });
}

/** Signing out in the app: the device key revokes itself (and its push registration). */
export async function DELETE(request: Request) {
	const env = getEnv();
	const auth = await authenticateApiRequest(env, request);
	if (!auth || auth.keyKind !== "device") return json({ error: "Unauthorized" }, 401);
	await revokeDeviceKey(env, auth.userId, auth.keyId);
	return json({ ok: true });
}

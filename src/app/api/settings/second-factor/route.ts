import { and, eq, gt, isNotNull, or } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { users } from "@/db/schema";
import { getEnv } from "@/lib/cloudflare";
import { requireSessionUser } from "@/lib/api/auth";
import { readJsonBody } from "@/lib/http/request";
import { requireSecondFactorSchema } from "@/lib/validators";
import { getSessionTokenFromRequestHeaders } from "@/lib/auth/session";
import { bumpSecurityVersion, consumeStepUpGrant } from "@/lib/auth/webauthn/grants";
import { authError } from "@/lib/http/auth-error";

/** Controls whether a password sign-in needs a passkey or a code. Passkeys themselves never do. */
export async function POST(request: Request) {
	const env = getEnv();
	const auth = await requireSessionUser(env, request);
	if (auth.error) return authError("session_expired", 401);
	const parsed = requireSecondFactorSchema.safeParse(await readJsonBody(request, 16 * 1024).catch(() => null));
	const sessionToken = getSessionTokenFromRequestHeaders(request);
	if (!parsed.success || !sessionToken) return authError("verification_required", 400);
	const db = getDb(env);
	if (parsed.data.enabled) {
		// Reject before spending the grant when no usable factor exists.
		const [factor] = await db
			.select({ id: users.id })
			.from(users)
			.where(and(eq(users.id, auth.user.id), or(and(eq(users.totpEnabled, true), isNotNull(users.totpSecret)), gt(users.passkeyCount, 0))))
			.limit(1);
		if (!factor) return authError("last_method", 409);
	}
	if (!(await consumeStepUpGrant(env, {
		token: parsed.data.stepUpToken,
		userId: auth.user.id,
		sessionToken,
		action: "second_factor.toggle",
	}))) {
		return authError("verification_required", 401);
	}
	// The conditional update keeps the factor check and the write together.
	let enabled: { id: string }[];
	try {
		enabled = parsed.data.enabled
			? await db
					.update(users)
					.set({ requireSecondFactor: true })
					.where(
						and(
							eq(users.id, auth.user.id),
							or(and(eq(users.totpEnabled, true), isNotNull(users.totpSecret)), gt(users.passkeyCount, 0)),
						),
					)
					.returning({ id: users.id })
			: await db.update(users).set({ requireSecondFactor: false }).where(eq(users.id, auth.user.id)).returning({ id: users.id });
	} catch (error) {
		if (String(error).includes("second-factor-unavailable")) return authError("last_method", 409);
		throw error;
	}
	if (!enabled.length) return authError("last_method", 409);
	await bumpSecurityVersion(db, auth.user.id);
	return NextResponse.json({ ok: true, requireSecondFactor: parsed.data.enabled });
}

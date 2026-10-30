import { and, eq, gt, sql } from "drizzle-orm";
import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { getDb } from "@/db";
import { users } from "@/db/schema";
import { requireUser } from "@/lib/auth/cookies";
import { deleteUserSessions, getSessionTokenFromRequestHeaders } from "@/lib/auth/session";
import { hasPasswordHash, hashPassword, PASSWORDLESS_PASSWORD_HASH, verifyPassword } from "@/lib/auth/password";
import { getEnv } from "@/lib/cloudflare";
import { readJsonBody } from "@/lib/http/request";
import { passwordSetSchema, stepUpTokenSchema } from "@/lib/validators";
import { bumpSecurityVersion, consumeStepUpGrant } from "@/lib/auth/webauthn/grants";
import { countPasskeys } from "@/lib/auth/webauthn/credentials";
import { recordAuthActivity } from "@/lib/auth/activity";
import { authError, isLastAuthMethodError } from "@/lib/http/auth-error";
import type { ChangePasswordInput } from "./types";
import { parseChangePasswordRequest } from "./utils";

export async function PATCH(request: Request) {
	const env = getEnv();
	const user = await requireUser(env, request);
	let parsed: ChangePasswordInput;

	try {
		parsed = await parseChangePasswordRequest(request);
	} catch (err) {
		if (err instanceof ZodError) return authError("invalid_request", 400);
		return authError("invalid_request", 400);
	}

	if (!hasPasswordHash(user.passwordHash)) {
		return authError("verification_required", 400);
	}
	if (!verifyPassword(parsed.currentPassword, user.passwordHash)) {
		return authError("password_incorrect", 400);
	}
	if (verifyPassword(parsed.newPassword, user.passwordHash)) {
		return authError("invalid_request", 400);
	}

	const db = getDb(env);
	const [updated] = await db
		.update(users)
		.set({ passwordHash: hashPassword(parsed.newPassword) })
		.where(and(
			eq(users.id, user.id),
			eq(users.passwordHash, user.passwordHash),
			eq(users.securityVersion, user.securityVersion),
			eq(users.totpEnabled, user.totpEnabled),
			eq(users.requireSecondFactor, user.requireSecondFactor),
		))
		.returning({ id: users.id });
	if (!updated) return authError("action_conflict", 409);
	await bumpSecurityVersion(db, user.id);
	// Anyone else holding a session for this account is signed out; this one stays.
	await deleteUserSessions(env, user.id, getSessionTokenFromRequestHeaders(request));

	return NextResponse.json({ ok: true });
}

/** Gives a passkey-only account a password, after re-authenticating. */
export async function POST(request: Request) {
	const env = getEnv();
	const user = await requireUser(env, request);
	if (hasPasswordHash(user.passwordHash)) {
		return authError("invalid_request", 409);
	}
	const parsed = passwordSetSchema.safeParse(await readJsonBody(request, 16 * 1024).catch(() => null));
	const sessionToken = getSessionTokenFromRequestHeaders(request);
	if (!parsed.success || !sessionToken) return authError("verification_required", 400);
	if (!(await consumeStepUpGrant(env, {
		token: parsed.data.stepUpToken,
		userId: user.id,
		sessionToken,
		action: "password.set",
	}))) {
		return authError("verification_required", 401);
	}
	const db = getDb(env);
	try {
		const updated = await db.update(users).set({
			passwordHash: hashPassword(parsed.data.newPassword),
			...(parsed.data.requireSecondFactor === undefined ? {} : { requireSecondFactor: parsed.data.requireSecondFactor }),
		}).where(and(
			eq(users.id, user.id),
			eq(users.passwordHash, user.passwordHash),
			eq(users.securityVersion, user.securityVersion),
			eq(users.totpEnabled, user.totpEnabled),
			eq(users.requireSecondFactor, user.requireSecondFactor),
			...(parsed.data.requireSecondFactor ? [gt(users.passkeyCount, 0)] : []),
		)).returning({ id: users.id });
		if (!updated.length) return authError("verification_required", 409);
	} catch (error) {
		if (isLastAuthMethodError(error)) return authError("last_method", 409);
		throw error;
	}
	await bumpSecurityVersion(db, user.id);
	await deleteUserSessions(env, user.id, sessionToken);
	await recordAuthActivity(env, { action: "auth.password_set", userId: user.id, request });
	return NextResponse.json({ ok: true });
}

/** Removing the password is only allowed while another sign-in method remains. */
export async function DELETE(request: Request) {
	const env = getEnv();
	const user = await requireUser(env, request);
	const parsed = stepUpTokenSchema.safeParse(await readJsonBody(request, 16 * 1024).catch(() => null));
	const sessionToken = getSessionTokenFromRequestHeaders(request);
	if (!parsed.success || !sessionToken) return authError("verification_required", 400);
	if ((await countPasskeys(env, user.id)) === 0) return authError("last_method", 409);
	if (!(await consumeStepUpGrant(env, {
		token: parsed.data.stepUpToken,
		userId: user.id,
		sessionToken,
		action: "password.remove",
	}))) {
		return authError("verification_required", 401);
	}
	const db = getDb(env);
	try {
		await db
			.update(users)
			.set({
				passwordHash: PASSWORDLESS_PASSWORD_HASH,
				// Decide from the row at write time, not the request snapshot: a
				// concurrent TOTP confirmation must not be downgraded.
				requireSecondFactor: sql`case when ${users.totpEnabled} then ${users.requireSecondFactor} else false end`,
			})
			.where(eq(users.id, user.id));
		await bumpSecurityVersion(db, user.id);
	} catch (error) {
		// The users trigger rejects this when a concurrent passkey removal won.
		if (isLastAuthMethodError(error)) return authError("last_method", 409);
		throw error;
	}
	await deleteUserSessions(env, user.id, sessionToken);
	await recordAuthActivity(env, { action: "auth.password_removed", userId: user.id, request });
	return NextResponse.json({ ok: true });
}

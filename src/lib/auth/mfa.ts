import { and, eq, isNull, lt, or, sql } from "drizzle-orm";
import QRCode from "qrcode";
import { getDb } from "@/db";
import { mfaRecoveryCodes, users } from "@/db/schema";
import { getBranding } from "@/lib/branding/service";
import { consumeRecoveryCode, countUnusedRecoveryCodes, issueRecoveryCodes } from "@/lib/auth/recovery-codes";
import { deleteUserSessions } from "@/lib/auth/session";
import { buildOtpauthUrl, generateTotpSecret, matchTotpStep } from "@/lib/auth/totp";
import type { MfaEnrollment, MfaStatus } from "@/lib/auth/mfa-types";

export async function getMfaStatus(env: CloudflareEnv, user: { id: string; totpEnabled: boolean; totpConfirmedAt: Date | null }): Promise<MfaStatus> {
	return {
		enabled: user.totpEnabled,
		confirmedAt: user.totpConfirmedAt?.toISOString() ?? null,
		recoveryCodesLeft: user.totpEnabled ? await countUnusedRecoveryCodes(env, user.id) : 0,
	};
}

/**
 * Start enrolment: a fresh secret is stored but not yet trusted. It only
 * becomes the account's second factor once `confirmMfaEnrollment` sees a
 * code generated from it, which proves the authenticator has it.
 */
export async function beginMfaEnrollment(env: CloudflareEnv, user: { id: string; email: string }): Promise<MfaEnrollment> {
	const db = getDb(env);
	const secret = generateTotpSecret();
	await db.update(users).set({ totpSecret: secret, totpEnabled: false, totpConfirmedAt: null, totpLastStep: null }).where(eq(users.id, user.id));
	const { appName } = await getBranding(env);
	const otpauthUrl = buildOtpauthUrl({ issuer: appName, account: user.email, secret });
	const qrSvg = await QRCode.toString(otpauthUrl, { type: "svg", margin: 1, errorCorrectionLevel: "M" });
	return { secret, otpauthUrl, qrSvg };
}

export async function confirmMfaEnrollment(
	env: CloudflareEnv,
	user: { id: string; totpSecret: string | null; totpEnabled: boolean },
	code: string,
	currentSessionToken?: string,
): Promise<{ ok: true; recoveryCodes: string[] } | { ok: false; error: string }> {
	if (!user.totpSecret) return { ok: false, error: "Start enrolment first" };
	if (user.totpEnabled) return { ok: false, error: "Two-factor authentication is already on" };
	const step = await matchTotpStep(user.totpSecret, code);
	if (step === null) return { ok: false, error: "That code did not match. Check the time on your device and try again." };

	const db = getDb(env);
	// The confirming code is spent: it cannot also sign in.
	await db.update(users).set({ totpEnabled: true, totpConfirmedAt: new Date(), requireSecondFactor: true, totpLastStep: step }).where(eq(users.id, user.id));
	const recoveryCodes = await issueRecoveryCodes(env, user.id);
	// Other sessions predate the second factor; make them sign in again with it.
	await deleteUserSessions(env, user.id, currentSessionToken);
	return { ok: true, recoveryCodes };
}

/**
 * Turning TOTP off leaves the second-factor requirement as the account had it:
 * a passkey can take over, but an account that never asked for a second step
 * does not start requiring one. Recovery codes alone are a fallback, not a
 * primary factor, so they do not keep the requirement on.
 */
export async function disableMfa(env: CloudflareEnv, userId: string): Promise<void> {
	const db = getDb(env);
	// The requirement follows the remaining passkeys in the same statement, so a
	// concurrent passkey deletion cannot leave a required-but-missing factor.
	await db
		.update(users)
		.set({
			totpSecret: null,
			totpEnabled: false,
			totpConfirmedAt: null,
			totpLastStep: null,
			requireSecondFactor: sql`case when ${users.passkeyCount} > 0 then ${users.requireSecondFactor} else false end`,
		})
		.where(eq(users.id, userId));
	await db.delete(mfaRecoveryCodes).where(eq(mfaRecoveryCodes.userId, userId));
}

/**
 * Record a TOTP step as used. The conditional update is the check: of any
 * number of concurrent requests with the same code, only one changes a row,
 * and a step at or below the last accepted one never does.
 */
async function claimTotpStep(env: CloudflareEnv, userId: string, step: number): Promise<boolean> {
	const claimed = await getDb(env)
		.update(users)
		.set({ totpLastStep: step })
		.where(and(eq(users.id, userId), or(isNull(users.totpLastStep), lt(users.totpLastStep, step))))
		.returning({ id: users.id });
	return claimed.length > 0;
}

/** A login's second step: a TOTP code, or one of the recovery codes as a fallback. */
export async function verifySecondFactor(
	env: CloudflareEnv,
	user: { id: string; totpSecret: string | null; totpEnabled: boolean },
	code: string,
): Promise<"totp" | "recovery" | null> {
	if (user.totpEnabled && user.totpSecret) {
		const step = await matchTotpStep(user.totpSecret, code);
		if (step !== null && (await claimTotpStep(env, user.id, step))) return "totp";
	}
	// Recovery codes belong to the authenticator flow. They must not become a
	// second factor for an account that never enrolled TOTP.
	if (user.totpEnabled && (await consumeRecoveryCode(env, user.id, code))) return "recovery";
	return null;
}

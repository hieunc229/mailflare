import { and, eq, gt, isNull } from "drizzle-orm";
import { getDb } from "@/db";
import { passwordResetTokens, users } from "@/db/schema";
import { newId } from "@/lib/ids";
import { hasPasswordHash, hashPassword } from "@/lib/auth/password";
import { deleteUserSessions, hashSessionToken } from "@/lib/auth/session";
import { getBranding } from "@/lib/branding/service";
import { sendSystemEmail } from "@/lib/email/system-mail";
import { createAuditLog } from "@/lib/mailboxes/audit";
import { getClientIp } from "@/lib/auth/client-ip";
import { buildPasswordResetEmail } from "@/lib/auth/password-reset-utils";
import type { Translator } from "@/lib/i18n/utils";

const TOKEN_MINUTES = 30;

/**
 * Mail a reset link to the account's recovery address. Silent about whether
 * the account exists or has one: the caller always answers the same way, so
 * the form cannot be used to probe for addresses.
 */
export async function requestPasswordReset(env: CloudflareEnv, email: string, origin: string, t: Translator): Promise<void> {
	const db = getDb(env);
	const [user] = await db.select().from(users).where(eq(users.email, email.trim().toLowerCase())).limit(1);
	// A passkey-only account must not regain password sign-in through email.
	if (!user || user.disabled || !user.resetEmail || !hasPasswordHash(user.passwordHash)) return;

	const token = newId("prt");
	await db.insert(passwordResetTokens).values({
		id: newId(),
		userId: user.id,
		tokenHash: await hashSessionToken(token),
		expiresAt: new Date(Date.now() + TOKEN_MINUTES * 60 * 1000),
	});

	const link = `${origin}/reset-password?token=${encodeURIComponent(token)}`;
	const { appName } = await getBranding(env);
	const sent = await sendSystemEmail(env, {
		to: user.resetEmail,
		...buildPasswordResetEmail(t, { email: user.email, appName, link, minutes: TOKEN_MINUTES }),
	});
	if (!sent) console.warn("Password reset requested but no domain can send mail; link not delivered");
}

/** Redeem a link: sets the password, burns the token, and signs the user out everywhere. */
export async function completePasswordReset(
	env: CloudflareEnv,
	token: string,
	newPassword: string,
	request: Request,
): Promise<{ ok: true } | { ok: false; error: string }> {
	const db = getDb(env);
	const [row] = await db
		.select({
			id: passwordResetTokens.id,
			userId: passwordResetTokens.userId,
			passwordHash: users.passwordHash,
			securityVersion: users.securityVersion,
			totpEnabled: users.totpEnabled,
			requireSecondFactor: users.requireSecondFactor,
		})
		.from(passwordResetTokens)
		.innerJoin(users, eq(users.id, passwordResetTokens.userId))
		.where(
			and(
				eq(passwordResetTokens.tokenHash, await hashSessionToken(token)),
				gt(passwordResetTokens.expiresAt, new Date()),
				isNull(passwordResetTokens.usedAt),
			),
		)
		.limit(1);
	if (!row || !hasPasswordHash(row.passwordHash)) return { ok: false, error: "This reset link is invalid or has expired. Request a new one." };

	// A password reset never creates a password for a passkey-only account; a
	// token issued before the password was removed must not become a bypass.
	const consumed = await db
		.update(passwordResetTokens)
		.set({ usedAt: new Date() })
		.where(and(eq(passwordResetTokens.id, row.id), isNull(passwordResetTokens.usedAt)))
		.returning({ id: passwordResetTokens.id });
	if (!consumed.length) return { ok: false, error: "This reset link is invalid or has expired. Request a new one." };
	// The token read above is only a snapshot. Re-check the account's complete
	// security state in the write itself so a concurrent passkey-only recovery,
	// password change or MFA change cannot be overwritten by this request.
	const [updated] = await db
		.update(users)
		.set({ passwordHash: hashPassword(newPassword) })
		.where(and(
			eq(users.id, row.userId),
			eq(users.passwordHash, row.passwordHash),
			eq(users.securityVersion, row.securityVersion),
			eq(users.totpEnabled, row.totpEnabled),
			eq(users.requireSecondFactor, row.requireSecondFactor),
		))
		.returning({ id: users.id });
	if (!updated) return { ok: false, error: "This reset link is invalid or has expired. Request a new one." };
	await deleteUserSessions(env, row.userId);
	await createAuditLog(env, {
		actorUserId: row.userId,
		targetUserId: row.userId,
		action: "auth.password_reset",
		metadata: { ipAddress: getClientIp(request) ?? "unknown" },
	});
	return { ok: true };
}

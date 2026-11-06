import { and, eq, ne } from "drizzle-orm";
import { getEnv } from "@/lib/cloudflare";
import { getDb } from "@/db";
import { mfaRecoveryCodes, passkeyCredentials, users } from "@/db/schema";
import { readJsonBody } from "@/lib/http/request";
import { RequestBodyTooLargeError } from "@/lib/http/errors";
import { passkeySetupSchema } from "@/lib/validators";
import { bumpSecurityVersion, consumeEnrollmentGrant, getEnrollmentGrant, SETUP_COOKIE } from "@/lib/auth/webauthn/grants";
import { buildPasskeyRow, deletePasskey } from "@/lib/auth/webauthn/credentials";
import {
	consumeWebAuthnChallenge,
	readCeremonyBindings,
	removeCeremonyCookie,
} from "@/lib/auth/webauthn/challenges";
import { isRegistrationResponseJSON, savePasskeyRegistration, verifyPasskeyRegistrationResponse } from "@/lib/auth/webauthn/service";
import { PASSWORDLESS_PASSWORD_HASH } from "@/lib/auth/password";
import { deleteUserSessions } from "@/lib/auth/session";
import { completeLogin } from "@/lib/auth/login-response";
import { recordAuthActivity } from "@/lib/auth/activity";
import { authError } from "@/lib/http/auth-error";

/**
 * Completes first-run setup or administrator recovery by enrolling a new
 * passkey. A recovery grant is not a session: until this succeeds it can only
 * reach these routes.
 */
export async function POST(request: Request) {
	const env = getEnv();
	let body: unknown;
	try {
		body = await readJsonBody(request, 64 * 1024);
	} catch (error) {
		const status = error instanceof RequestBodyTooLargeError ? 413 : 400;
		return authError("invalid_request", status);
	}
	const parsed = passkeySetupSchema.safeParse(body);
	if (!parsed.success || !isRegistrationResponseJSON(parsed.data.response)) {
		return authError("passkey_invalid", 400);
	}
	const grant = await getEnrollmentGrant(env, parsed.data.token);
	if (!grant) return authError("setup_invalid", 401);
	const [user] = await getDb(env).select().from(users).where(eq(users.id, grant.userId)).limit(1);
	if (!user || user.disabled || user.deletedAt) return authError("account_disabled", 403);
	const bindings = readCeremonyBindings(request);
	if (bindings.length === 0) return authError("setup_invalid", 401);
	const challenge = await consumeWebAuthnChallenge(env, {
		ceremonyToken: parsed.data.ceremonyToken,
		purpose: grant.kind === "setup" ? "enroll" : "recovery",
		bindings,
	});
	if (!challenge || challenge.userId !== user.id) {
		return authError("setup_invalid", 401);
	}

	try {
		// Verify before touching any existing credential. A bad response must
		// never remove the account's current way in.
		const verified = await verifyPasskeyRegistrationResponse(env, request, parsed.data.response, challenge.challenge);
		const db = getDb(env);
		if (grant.kind === "setup") {
			const passkey = await savePasskeyRegistration(env, user.id, verified, parsed.data.name);
			if (!(await consumeEnrollmentGrant(env, grant.id))) {
				await deletePasskey(env, user.id, passkey.id);
				return authError("setup_invalid", 401);
			}
			await bumpSecurityVersion(db, user.id);
		} else {
			// Claim the grant before replacing state, so concurrent requests
			// cannot both replace credentials.
			if (!(await consumeEnrollmentGrant(env, grant.id))) {
				return authError("setup_invalid", 401);
			}
			const row = await buildPasskeyRow(env, {
				userId: user.id,
				credentialId: verified.credentialId,
				publicKey: verified.publicKey,
				counter: verified.counter,
				deviceType: verified.deviceType,
				backedUp: verified.backedUp,
				aaguid: verified.aaguid,
				transports: verified.transports,
				name: parsed.data.name,
			});
			// Create the replacement first. Doing this before any delete keeps a
			// failed insert from removing the account's remaining way in, even on
			// drivers without transactions (Neon HTTP).
			const [sameCredential] = await db
				.select({ id: passkeyCredentials.id })
				.from(passkeyCredentials)
				.where(and(eq(passkeyCredentials.userId, user.id), eq(passkeyCredentials.credentialHash, row.credentialHash)))
				.limit(1);
			let newPasskeyId: string;
			if (sameCredential) {
				newPasskeyId = sameCredential.id;
				await db
					.update(passkeyCredentials)
					.set({
						publicKey: row.publicKey,
						counter: row.counter,
						transports: row.transports,
						deviceType: row.deviceType,
						backedUp: row.backedUp,
						aaguid: row.aaguid,
						name: row.name,
						lastUsedAt: null,
					})
					.where(eq(passkeyCredentials.id, sameCredential.id));
			} else {
				newPasskeyId = row.id;
				await db.insert(passkeyCredentials).values(row);
			}
			// Now remove every other credential and invalidate the old password,
			// TOTP, and second-factor requirement. If this fails, do not report a
			// completed recovery: the new passkey exists, but old methods may still
			// be usable and the user must review them after signing in with it.
			try {
				await db.batch([
					db.delete(passkeyCredentials).where(and(eq(passkeyCredentials.userId, user.id), ne(passkeyCredentials.id, newPasskeyId))),
					db.delete(mfaRecoveryCodes).where(eq(mfaRecoveryCodes.userId, user.id)),
					db
						.update(users)
						.set({
							passwordHash: PASSWORDLESS_PASSWORD_HASH,
							totpSecret: null,
							totpEnabled: false,
							totpConfirmedAt: null,
							requireSecondFactor: false,
						})
						.where(eq(users.id, user.id)),
				]);
				await bumpSecurityVersion(db, user.id);
			} catch {
				throw new Error("recovery-cleanup-failed");
			}
		}
		if (grant.kind !== "setup") {
			await deleteUserSessions(env, user.id);
		}
		const response = await completeLogin(env, request, user.id, {
			activity: "auth.passkey_verified",
			body: { setup: grant.kind === "setup" ? "passkey" : "recovery" },
		});
		await recordAuthActivity(env, {
			action: grant.kind === "setup" ? "auth.passkey_setup" : "auth.recovery_completed",
			userId: user.id,
			request,
		});
		response.cookies.set(SETUP_COOKIE, "", {
			httpOnly: true,
			secure: process.env.NODE_ENV === "production",
			sameSite: "lax",
			path: "/",
			maxAge: 0,
		});
		removeCeremonyCookie(response.headers, request, challenge.binding);
		return response;
	} catch (error) {
		const failed = error instanceof Error && error.message === "recovery-cleanup-failed";
		const response = authError(failed ? "recovery_cleanup_failed" : "passkey_invalid", failed ? 500 : 400);
		removeCeremonyCookie(response.headers, request, challenge.binding);
		return response;
	}
}

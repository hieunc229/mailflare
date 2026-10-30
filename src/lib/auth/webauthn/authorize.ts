import { verifyPassword } from "@/lib/auth/password";
import { verifySecondFactor } from "@/lib/auth/mfa";
import { consumeStepUpGrant } from "./grants";
import type { StepUpAction } from "./step-up-types";

/**
 * A sensitive settings change may prove the password, or present a fresh
 * passkey step-up grant. When password sign-ins require a second factor, the
 * password path must also present a valid authenticator or recovery code.
 *
 * The grant is spent for exactly `action` and `targetUserId`; callers should
 * bump the target's security version after a successful change.
 */
export async function authorizeSecurityChange(
	env: CloudflareEnv,
	user: { id: string; passwordHash: string; requireSecondFactor: boolean; totpSecret: string | null; totpEnabled: boolean },
	sessionToken: string | undefined,
	input: { password?: string; stepUpToken?: string; code?: string },
	action: StepUpAction,
	options: { requireCode?: boolean; targetUserId?: string | null } = {},
): Promise<boolean> {
	if (input.stepUpToken) {
		if (!sessionToken) return false;
		return consumeStepUpGrant(env, {
			token: input.stepUpToken,
			userId: user.id,
			sessionToken,
			action,
			targetUserId: options.targetUserId,
		});
	}
	if (!input.password || !verifyPassword(input.password, user.passwordHash)) return false;
	if (!options.requireCode && !user.requireSecondFactor) return true;
	return !!input.code && !!(await verifySecondFactor(env, user, input.code));
}

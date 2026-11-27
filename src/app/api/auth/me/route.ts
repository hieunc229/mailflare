import { NextResponse } from "next/server";
import { getEnv } from "@/lib/cloudflare";
import { requireSessionUser } from "@/lib/api/auth";
import { hasPrimaryDomain, userHasMailboxes } from "@/lib/user";
import { getLicenseEntitlements } from "@/lib/licenses/service";
import { hasCloudflareCredentials, isNodeRuntime, isVercelRuntime } from "@/lib/runtime";

export async function GET(request: Request) {
	const env = getEnv();
	// `requireSessionUser` also turns a database behind on migrations into a 409 saying so,
	// instead of the 500 that reads as a broken sign-in.
	const auth = await requireSessionUser(env, request);
	if (auth.error) return auth.error;
	const user = auth.user;

	const [entitlements, setup] = await Promise.all([
		getLicenseEntitlements(env),
		// Authentication remains valid when optional mailbox/setup metadata is unavailable.
		Promise.all([
			userHasMailboxes(env, user.id),
			hasPrimaryDomain(env),
		]).catch((): [boolean, boolean] => [false, true]),
	]);
	const [hasMailboxes, isSetup] = setup;
	return NextResponse.json({
		user: {
			id: user.id,
			email: user.email,
			name: user.name,
			timeZone: user.timeZone,
			resetEmail: user.resetEmail,
			forwardingEmail: user.forwardingEmail,
			canForwardEmail: entitlements.canForwardEmail,
			role: user.role,
			isPrimaryAdmin: user.isPrimaryAdmin,
			canManageMailboxes: user.canManageMailboxes,
			canManageDomains: user.canManageDomains,
			canManageUsers: user.canManageUsers,
			calendarEnabled: user.calendarEnabled,
			driveEnabled: user.driveEnabled,
			keyboardShortcutsEnabled: user.keyboardShortcutsEnabled,
			spamProtectionEnabled: user.spamProtectionEnabled,
			spamStrictness: user.spamStrictness,
			showFullRecipientAddresses: user.showFullRecipientAddresses,
			hasAvatar: !!user.avatarKey,
			mfaEnabled: user.totpEnabled,
		},
		runtime: isNodeRuntime(env) ? "node" : isVercelRuntime(env) ? "vercel" : "cloudflare",
		managesDns: hasCloudflareCredentials(env),
		hasMailboxes,
		isSetup,
	});
}

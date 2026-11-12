import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth/cookies";
import { getEnv } from "@/lib/cloudflare";
import { hasPrimaryDomain, userHasMailboxes } from "@/lib/user";
import { getLicenseEntitlements } from "@/lib/licenses/service";
import { hasCloudflareCredentials, isNodeRuntime } from "@/lib/runtime";

export async function GET(request: Request) {
	const env = getEnv();
	const user = await getCurrentUser(env, request);
	if (!user) {
		return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
	}

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
			showFullRecipientAddresses: user.showFullRecipientAddresses,
			hasAvatar: !!user.avatarKey,
			mfaEnabled: user.totpEnabled,
		},
		runtime: isNodeRuntime(env) ? "node" : "cloudflare",
		managesDns: hasCloudflareCredentials(env),
		hasMailboxes,
		isSetup,
	});
}

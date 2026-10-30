import { NextResponse } from "next/server";
import { getEnv } from "@/lib/cloudflare";
import { requireSessionUser } from "@/lib/api/auth";
import { hasPasswordHash } from "@/lib/auth/password";
import { countUnusedRecoveryCodes } from "@/lib/auth/recovery-codes";
import { listPasskeys } from "@/lib/auth/webauthn/credentials";

export async function GET(request: Request) {
	const env = getEnv();
	const auth = await requireSessionUser(env, request);
	if (auth.error) return auth.error;
	const [passkeys, recoveryCodesLeft] = await Promise.all([
		listPasskeys(env, auth.user.id),
		countUnusedRecoveryCodes(env, auth.user.id),
	]);
	return NextResponse.json({
		passwordSet: hasPasswordHash(auth.user.passwordHash),
		requireSecondFactor: auth.user.requireSecondFactor,
		totpEnabled: auth.user.totpEnabled,
		recoveryCodesLeft,
		passkeys: passkeys
			.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
			.map((passkey) => ({
				id: passkey.id,
				name: passkey.name,
				createdAt: passkey.createdAt.toISOString(),
				lastUsedAt: passkey.lastUsedAt?.toISOString() ?? null,
				backedUp: passkey.backedUp,
				deviceType: passkey.deviceType,
				aaguid: passkey.aaguid,
			})),
	}, { headers: { "Cache-Control": "no-store" } });
}

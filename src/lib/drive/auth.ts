import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { getEnv } from "@/lib/cloudflare";
import { requireSessionUser } from "@/lib/api/auth";
import { hasValidSessionMutationOrigin } from "@/lib/auth/origin";

/** Drive is a per-user app an admin can switch off; every Drive API goes through authorizeDrive. */
export function driveAccessError(user: { driveEnabled: boolean } | null | undefined) {
	return user && !user.driveEnabled
		? NextResponse.json({ error: "Drive is disabled for this account" }, { status: 403 })
		: null;
}

export async function authorizeDrive(request: Request, mutation = false) {
	const env = getEnv();
	const { user, error } = await requireSessionUser(env, request);
	if (error) return { error } as const;
	if (mutation && !hasValidSessionMutationOrigin(request)) return { error: NextResponse.json({ error: "Invalid origin" }, { status: 403 }) } as const;
	const denied = driveAccessError(user);
	if (denied) return { error: denied } as const;
	return { env, db: getDb(env), user, error: null } as const;
}

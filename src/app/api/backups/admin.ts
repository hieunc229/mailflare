import { NextResponse } from "next/server";
import { isPrimaryAdmin } from "@/lib/auth/admin";
import { requireUser } from "@/lib/auth/cookies";
import { UnauthorizedError } from "@/lib/auth/unauthorized";
import { getEnv } from "@/lib/cloudflare";

/**
 * Primary-admin gate for the backup routes: 401 when signed out, 403 for anyone but the primary admin.
 * Any other failure (for example the session lookup hitting a database error) is not an auth answer and
 * is rethrown.
 */
export async function authorizeBackupAdmin(request: Request) {
	const env = getEnv();
	let user: Awaited<ReturnType<typeof requireUser>>;
	try {
		user = await requireUser(env, request);
	} catch (error) {
		if (!(error instanceof UnauthorizedError)) throw error;
		return { env, user: null, error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) } as const;
	}
	if (!isPrimaryAdmin(user)) {
		return { env, user: null, error: NextResponse.json({ error: "Forbidden" }, { status: 403 }) } as const;
	}
	return { env, user, error: null } as const;
}

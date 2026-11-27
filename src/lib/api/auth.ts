import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth/cookies";
import { migrationRequired } from "@/lib/http/migration-required";
import { authenticateApiKeyValue, hasScope } from "@/lib/api/key-auth";
import type { ApiAuthResult } from "@/lib/api/key-auth-types";

export type { ApiAuthResult };

export async function authenticateApiKey(
	env: CloudflareEnv,
	authorization: string | null,
): Promise<ApiAuthResult | null> {
	if (!authorization?.startsWith("Bearer ")) return null;
	return authenticateApiKeyValue(env, authorization.slice(7));
}

export const requireScope = hasScope;

/**
 * Session auth for route handlers that want the 401 response in hand. `requireUser` throws an
 * `UnauthorizedError`, which the route runtime turns into a 401 when a handler lets it escape.
 */
export async function requireSessionUser(env: CloudflareEnv, request: Request) {
	let user: Awaited<ReturnType<typeof getCurrentUser>>;
	try {
		user = await getCurrentUser(env, request);
	} catch (error) {
		// A database behind on migrations is not "not signed in": answering 401 would loop a
		// signed-in browser through the login page without saying what to fix.
		return { user: null, error: migrationRequired(error) } as const;
	}
	if (!user) {
		return { user: null, error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) } as const;
	}
	return { user, error: null } as const;
}

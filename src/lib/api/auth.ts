import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth/cookies";
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
	const user = await getCurrentUser(env, request);
	if (!user) {
		return { user: null, error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) } as const;
	}
	return { user, error: null } as const;
}

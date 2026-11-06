import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth/cookies";
import { authenticateApiRequest, hasScope } from "@/lib/api/key-auth";
import type { ApiAuthResult } from "@/lib/api/key-auth-types";
import type { CalendarAuthorization } from "./api-auth-types";

/** Calendar is a per-user app an admin can switch off; off applies to API keys and booking too. */
export function calendarAccessError(user: { calendarEnabled: boolean } | null | undefined) {
	return user && !user.calendarEnabled
		? NextResponse.json({ error: "Calendar is disabled for this account" }, { status: 403 })
		: null;
}

export async function authorizeCalendarRequest(env: CloudflareEnv, request: Request, scope: "calendar:read" | "calendar:write"): Promise<CalendarAuthorization> {
	const authorization = request.headers.get("Authorization") ?? "";
	if (authorization.startsWith("Bearer ep_") || authorization.startsWith("Basic ")) {
		const key = await authenticateApiRequest(env, request);
		if (!key) return { user: null, key: null, error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
		if (!hasScope(key.scopes, scope)) return { user: null, key: null, error: NextResponse.json({ error: "Permission denied" }, { status: 403 }) };
		const denied = calendarAccessError(key.user);
		return denied ? { user: null, key: null, error: denied } : { user: key.user, key, error: null };
	}
	const user = await getCurrentUser(env, request);
	if (!user) return { user: null, key: null, error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
	const denied = calendarAccessError(user);
	return denied ? { user: null, key: null, error: denied } : { user, key: null, error: null };
}

export function calendarKeyCanSendInvitations(key: ApiAuthResult | null, mailboxId: string | null | undefined): boolean {
	return !key || !!mailboxId && hasScope(key.scopes, "send") && (key.mailboxIds === null || key.mailboxIds.includes(mailboxId));
}

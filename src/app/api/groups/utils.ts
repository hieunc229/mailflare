import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { canManageUsers } from "@/lib/auth/admin";
import { requireUser } from "@/lib/auth/cookies";
import { hasValidSessionMutationOrigin } from "@/lib/auth/origin";
import { getEnv } from "@/lib/cloudflare";
import { isMissingTableError } from "@/lib/database-errors";
import { groupsAllowed } from "@/lib/groups/license";
import type { GroupResult } from "@/lib/groups/types";

/** Session auth for every groups route: a user manager on an installation licensed for accounts. */
export async function requireGroupsAdmin(request: Request, options: { mutation?: boolean } = {}) {
	const env = getEnv();
	let user: Awaited<ReturnType<typeof requireUser>>;
	try {
		user = await requireUser(env, request);
	} catch {
		return { error: NextResponse.json({ error: "Forbidden" }, { status: 403 }) };
	}
	if (!canManageUsers(user)) return { error: NextResponse.json({ error: "You do not have permission to manage groups" }, { status: 403 }) };
	if (!(await groupsAllowed(env)())) {
		return { error: NextResponse.json({ error: "A Pro or Team license is required to manage groups", code: "LICENSE_REQUIRED" }, { status: 403 }) };
	}
	if (options.mutation && !hasValidSessionMutationOrigin(request)) return { error: NextResponse.json({ error: "Invalid origin" }, { status: 403 }) };
	return { env, db: getDb(env), user, error: null };
}

/** Maps a service result to a response, answering 503 while the groups migration is not applied. */
export async function respond<T>(run: () => Promise<GroupResult<T>>, success: { status?: number; map?: (data: T) => unknown } = {}) {
	try {
		const result = await run();
		if (!result.ok) return NextResponse.json({ error: result.error, ...(result.code ? { code: result.code } : {}) }, { status: result.status });
		return NextResponse.json(success.map ? success.map(result.data) : result.data, { status: success.status ?? 200 });
	} catch (error) {
		if (isMissingTableError(error)) {
			return NextResponse.json({ error: "Apply pending database migrations to use groups", code: "MIGRATION_REQUIRED" }, { status: 503 });
		}
		throw error;
	}
}

export async function readJson(request: Request): Promise<unknown> {
	return request.json().catch(() => null);
}

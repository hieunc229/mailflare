import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { authenticateAdminApiKey } from "@/lib/api/admin-auth";
import { getEnv } from "@/lib/cloudflare";
import { groupsAllowed } from "@/lib/groups/license";

export { readJson, respond, validationError } from "@/app/api/groups/utils";

/** Admin API key auth for every v1 groups route: the `groups` scope on an installation licensed for accounts. */
export async function requireGroupsKey(request: Request) {
	const env = getEnv();
	const auth = await authenticateAdminApiKey(env, request, "groups");
	if (!auth) return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
	if (!(await groupsAllowed(env)())) {
		return { error: NextResponse.json({ error: "A Pro or Team license is required to manage groups", code: "LICENSE_REQUIRED" }, { status: 403 }) };
	}
	return { env, db: getDb(env), user: auth.user, error: null };
}

import { desc, inArray, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { auditLogs, users } from "@/db/schema";
import { assertPrimaryAdmin } from "@/lib/auth/admin";
import { requireUser } from "@/lib/auth/cookies";
import { getEnv } from "@/lib/cloudflare";
import { parseLimit } from "@/lib/api/query-params";

export async function GET(request: Request) {
	const env = getEnv();
	const admin = await requireUser(env, request);
	try {
		assertPrimaryAdmin(admin);
	} catch {
		return NextResponse.json({ error: "Forbidden" }, { status: 403 });
	}

	const url = new URL(request.url);
	const limit = parseLimit(url.searchParams.get("limit"), 100, 200);
	const rows = await getDb(env)
		.select({
			id: auditLogs.id,
			action: auditLogs.action,
			metadata: auditLogs.metadata,
			createdAt: auditLogs.createdAt,
			actorEmail: users.email,
		})
		.from(auditLogs)
		.leftJoin(users, eq(users.id, auditLogs.actorUserId))
		.where(inArray(auditLogs.action, ["auth.login", "auth.logout"]))
		.orderBy(desc(auditLogs.createdAt))
		.limit(limit);

	return NextResponse.json({ activities: rows });
}

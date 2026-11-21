import { NextResponse } from "next/server";
import { assertAdmin } from "@/lib/auth/admin";
import { requireSessionUser } from "@/lib/api/auth";
import { getEnv } from "@/lib/cloudflare";
import { getSearchIndexStatus, rebuildSearchIndex } from "@/lib/search/index-admin";
import { hasValidSessionMutationOrigin } from "@/lib/auth/origin";

/** Row counts for the index versus the messages table, to spot drift. */
export async function GET(request: Request) {
	const env = getEnv();
	const auth = await requireSessionUser(env, request);
	if (auth.error) return auth.error;
	try {
		assertAdmin(auth.user);
	} catch {
		return NextResponse.json({ error: "Forbidden" }, { status: 403 });
	}
	return NextResponse.json(await getSearchIndexStatus(env));
}

/** Re-index every message from the messages table. Safe to run at any time. */
export async function POST(request: Request) {
	const env = getEnv();
	const auth = await requireSessionUser(env, request);
	if (auth.error) return auth.error;
	try {
		assertAdmin(auth.user);
	} catch {
		return NextResponse.json({ error: "Forbidden" }, { status: 403 });
	}
	if (!hasValidSessionMutationOrigin(request)) return NextResponse.json({ error: "Invalid origin" }, { status: 403 });
	await rebuildSearchIndex(env);
	return NextResponse.json(await getSearchIndexStatus(env));
}

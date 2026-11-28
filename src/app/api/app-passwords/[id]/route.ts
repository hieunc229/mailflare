import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { apiKeys } from "@/db/schema";
import { requireSessionUser } from "@/lib/api/auth";
import { revokeApiKey } from "@/lib/api-key-store";
import { isListedAsAppPassword } from "@/lib/auth/app-password-utils";
import { hasValidSessionMutationOrigin } from "@/lib/auth/origin";
import { getEnv } from "@/lib/cloudflare";

type Params = { params: Promise<{ id: string }> };

export async function DELETE(request: Request, { params }: Params) {
	const env = getEnv();
	const auth = await requireSessionUser(env, request);
	if (auth.error) return auth.error;
	if (!hasValidSessionMutationOrigin(request)) return NextResponse.json({ error: "Invalid origin" }, { status: 403 });
	const { id } = await params;
	const db = getDb(env);
	const [key] = await db.select({ kind: apiKeys.kind, scopes: apiKeys.scopes }).from(apiKeys).where(and(eq(apiKeys.id, id), eq(apiKeys.userId, auth.user.id))).limit(1);
	// Only what the list shows: device keys, API keys and admin keys are managed elsewhere.
	if (!key || !isListedAsAppPassword(key)) return NextResponse.json({ error: "App password not found" }, { status: 404 });
	await revokeApiKey(db, env, { id, userId: auth.user.id, kind: key.kind, scopes: key.scopes, request });
	return NextResponse.json({ ok: true });
}

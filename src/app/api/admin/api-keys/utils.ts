import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { getEnv } from "@/lib/cloudflare";
import { getDb } from "@/db";
import { agentSendApprovals, apiKeys } from "@/db/schema";
import { requireSessionUser } from "@/lib/api/auth";
import { isPrimaryAdmin } from "@/lib/auth/admin";
import { generateApiKey, parseScopes, scopesToJson } from "@/lib/api-keys";
import { ADMIN_API_KEY_SCOPES } from "@/lib/api/scopes";
import { newId } from "@/lib/ids";
import { hasValidSessionMutationOrigin } from "@/lib/auth/origin";

const adminScopes = new Set<string>(ADMIN_API_KEY_SCOPES);
const createKeySchema = z.object({
	name: z.string().trim().min(1).max(100),
	scopes: z.array(z.enum([...ADMIN_API_KEY_SCOPES])).min(1),
	mcpAllowed: z.boolean().default(false),
});

async function authorize(request: Request) {
	const env = getEnv();
	const session = await requireSessionUser(env, request);
	if (session.error) return { env, user: null, error: session.error };
	if (!isPrimaryAdmin(session.user)) return { env, user: null, error: NextResponse.json({ error: "Forbidden" }, { status: 403 }) };
	return { env, user: session.user, error: null };
}

export async function GET(request: Request) {
	const access = await authorize(request);
	if (access.error) return access.error;
	const rows = await getDb(access.env).select({
		id: apiKeys.id,
		name: apiKeys.name,
		prefix: apiKeys.prefix,
		kind: apiKeys.kind,
		scopes: apiKeys.scopes,
		createdAt: apiKeys.createdAt,
		lastUsedAt: apiKeys.lastUsedAt,
	}).from(apiKeys).where(eq(apiKeys.userId, access.user!.id));
	return NextResponse.json({ apiKeys: rows.map((row) => ({ ...row, scopes: scopesToJson(parseScopes(row.scopes).filter((scope) => adminScopes.has(scope))) })).filter((row) => parseScopes(row.scopes).length > 0) });
}

export async function POST(request: Request) {
	const access = await authorize(request);
	if (access.error) return access.error;
	if (!hasValidSessionMutationOrigin(request)) return NextResponse.json({ error: "Invalid origin" }, { status: 403 });
	const parsed = createKeySchema.safeParse(await request.json().catch(() => null));
	if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
	const db = getDb(access.env);
	const { fullKey, prefix, hash, sha256 } = await generateApiKey();
	const id = newId("key");
	await db.insert(apiKeys).values({
		id,
		kind: parsed.data.mcpAllowed ? "mcp" : "legacy",
		userId: access.user!.id,
		name: parsed.data.name,
		prefix,
		keyHash: hash,
		keySha256: sha256,
		scopes: scopesToJson([...new Set(parsed.data.scopes)]),
	});
	return NextResponse.json({ key: fullKey });
}

export async function DELETE(request: Request) {
	const access = await authorize(request);
	if (access.error) return access.error;
	if (!hasValidSessionMutationOrigin(request)) return NextResponse.json({ error: "Invalid origin" }, { status: 403 });
	const id = new URL(request.url).searchParams.get("id");
	if (!id) return NextResponse.json({ error: "Key required" }, { status: 400 });
	const db = getDb(access.env);
	const [key] = await db.select({ id: apiKeys.id, scopes: apiKeys.scopes }).from(apiKeys).where(and(eq(apiKeys.id, id), eq(apiKeys.userId, access.user!.id))).limit(1);
	if (!key || !parseScopes(key.scopes).some((scope) => adminScopes.has(scope))) return NextResponse.json({ error: "Key not found" }, { status: 404 });
	await db.update(agentSendApprovals).set({ status: "cancelled" }).where(and(eq(agentSendApprovals.requestKeyId, id), eq(agentSendApprovals.status, "pending")));
	await db.delete(apiKeys).where(eq(apiKeys.id, id));
	return NextResponse.json({ ok: true });
}

import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "@/db";
import { agentSendApprovals, apiKeys, mcpKeyMailboxes } from "@/db/schema";
import { getEnv } from "@/lib/cloudflare";
import { getCurrentUser } from "@/lib/auth/cookies";
import { generateApiKey, parseScopes, scopesToJson } from "@/lib/api-keys";
import { ADMIN_API_KEY_SCOPES } from "@/lib/api/scopes";
import { getMailboxAccessLevel } from "@/lib/mailboxes/access";
import { newId } from "@/lib/ids";
import { hasValidSessionMutationOrigin } from "@/lib/auth/origin";

const createSchema = z.object({ name: z.string().trim().min(1).max(100), mailboxIds: z.array(z.string()).max(30), scopes: z.array(z.enum(["mcp:read", "mcp:note", "mcp:draft", "mcp:organize", "mcp:request-send", "mcp:calendar-read", "mcp:calendar-write"])).min(1) });
const ADMIN_SCOPES = new Set<string>(ADMIN_API_KEY_SCOPES);

export async function GET(request: Request) {
	const env = getEnv();
	const user = await getCurrentUser(env, request);
	if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
	const db = getDb(env);
	const rows = await db.select({ id: apiKeys.id, name: apiKeys.name, prefix: apiKeys.prefix, scopes: apiKeys.scopes, lastUsedAt: apiKeys.lastUsedAt, createdAt: apiKeys.createdAt }).from(apiKeys).where(and(eq(apiKeys.userId, user.id), eq(apiKeys.kind, "mcp")));
	const keys = rows.filter((key) => !parseScopes(key.scopes).some((scope) => ADMIN_SCOPES.has(scope)));
	const allowed = keys.length ? await db.select().from(mcpKeyMailboxes).where(inArray(mcpKeyMailboxes.keyId, keys.map((key) => key.id))) : [];
	return Response.json({ keys: keys.map((key) => ({ ...key, mailboxIds: allowed.filter((row) => row.keyId === key.id).map((row) => row.mailboxId) })) });
}

export async function POST(request: Request) {
	const env = getEnv();
	const user = await getCurrentUser(env, request);
	if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
	if (!hasValidSessionMutationOrigin(request)) return Response.json({ error: "Invalid origin" }, { status: 403 });
	const parsed = createSchema.safeParse(await request.json().catch(() => null));
	if (!parsed.success) return Response.json({ error: "Invalid key request" }, { status: 400 });
	const db = getDb(env);
	const mailboxIds = [...new Set(parsed.data.mailboxIds)];
	if (!mailboxIds.length && parsed.data.scopes.some((scope) => !scope.startsWith("mcp:calendar-"))) return Response.json({ error: "Choose a mailbox for mail permissions" }, { status: 400 });
	for (const mailboxId of mailboxIds) if (!(await getMailboxAccessLevel(db, user, mailboxId))?.canRead) return Response.json({ error: "Mailbox not found" }, { status: 403 });
	const { fullKey, prefix, hash } = generateApiKey();
	const id = newId("key");
	await db.insert(apiKeys).values({ id, kind: "mcp", userId: user.id, name: parsed.data.name, prefix, keyHash: hash, scopes: scopesToJson([...new Set(parsed.data.scopes)]) });
	if (mailboxIds.length) await db.insert(mcpKeyMailboxes).values(mailboxIds.map((mailboxId) => ({ keyId: id, mailboxId })));
	return Response.json({ id, name: parsed.data.name, prefix, key: fullKey, mailboxIds, scopes: parsed.data.scopes });
}

export async function DELETE(request: Request) {
	const env = getEnv();
	const user = await getCurrentUser(env, request);
	if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
	if (!hasValidSessionMutationOrigin(request)) return Response.json({ error: "Invalid origin" }, { status: 403 });
	const id = new URL(request.url).searchParams.get("id");
	if (!id) return Response.json({ error: "Key required" }, { status: 400 });
	const [owned] = await getDb(env).select({ id: apiKeys.id }).from(apiKeys).where(and(eq(apiKeys.id, id), eq(apiKeys.userId, user.id), eq(apiKeys.kind, "mcp"))).limit(1);
	if (!owned) return Response.json({ error: "Key not found" }, { status: 404 });
	await getDb(env).update(agentSendApprovals).set({ status: "cancelled" }).where(and(eq(agentSendApprovals.requestKeyId, id), eq(agentSendApprovals.status, "pending")));
	await getDb(env).delete(apiKeys).where(and(eq(apiKeys.id, id), eq(apiKeys.userId, user.id), eq(apiKeys.kind, "mcp")));
	return Response.json({ ok: true });
}

import { NextResponse } from "next/server";
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { getEnv } from "@/lib/cloudflare";
import { getDb } from "@/db";
import { agentSendApprovals, apiKeys, mcpKeyMailboxes } from "@/db/schema";
import { requireUser } from "@/lib/auth/cookies";
import { generateApiKey, generateAppPassword, parseScopes, scopesToJson } from "@/lib/api-keys";
import { API_KEY_SCOPES } from "@/lib/api/scopes";
import { newId } from "@/lib/ids";
import { ADMIN_API_KEY_SCOPES } from "@/lib/api/scopes";
import { getMailboxAccessLevel } from "@/lib/mailboxes/access";
import { hasValidSessionMutationOrigin } from "@/lib/auth/origin";

const createKeySchema = z.object({
	name: z.string().trim().min(1).max(100),
	scopes: z.array(z.enum([...API_KEY_SCOPES])).min(1),
	mailboxIds: z.array(z.string().min(1)).max(30),
});

export async function GET(request: Request) {
	const env = getEnv();
	const user = await requireUser(env, request);
	const db = getDb(env);
	const rows = await db
		.select({
			id: apiKeys.id,
			name: apiKeys.name,
			prefix: apiKeys.prefix,
			kind: apiKeys.kind,
			mailboxScopeEnabled: apiKeys.mailboxScopeEnabled,
			scopes: apiKeys.scopes,
			createdAt: apiKeys.createdAt,
			lastUsedAt: apiKeys.lastUsedAt,
		})
		.from(apiKeys)
		.where(eq(apiKeys.userId, user.id));
	const keyIds = rows.map((row) => row.id);
	const allowed = keyIds.length ? await db.select().from(mcpKeyMailboxes).where(inArray(mcpKeyMailboxes.keyId, keyIds)) : [];
	return NextResponse.json({ apiKeys: rows.filter((row) => row.kind !== "device" && !parseScopes(row.scopes).some((scope) => (ADMIN_API_KEY_SCOPES as readonly string[]).includes(scope))).map((row) => ({ ...row, mailboxIds: allowed.filter((item) => item.keyId === row.id).map((item) => item.mailboxId) })) });
}

export async function POST(request: Request) {
	const env = getEnv();
	const user = await requireUser(env, request);
	if (!hasValidSessionMutationOrigin(request)) return NextResponse.json({ error: "Invalid origin" }, { status: 403 });
	const parsed = createKeySchema.safeParse(await request.json().catch(() => null));
	if (!parsed.success) {
		return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
	}

	const isAppPassword = parsed.data.scopes.length === 1 && parsed.data.scopes[0] === "jmap";
	const { fullKey, prefix, hash, sha256 } = isAppPassword ? await generateAppPassword() : await generateApiKey();
	const db = getDb(env);
	const mailboxIds = [...new Set(parsed.data.mailboxIds)];
	if (!mailboxIds.length && parsed.data.scopes.some((scope) => !scope.startsWith("calendar:"))) return NextResponse.json({ error: "Choose a mailbox for mail permissions" }, { status: 400 });
	for (const mailboxId of mailboxIds) if (!(await getMailboxAccessLevel(db, user, mailboxId))?.canRead) return NextResponse.json({ error: "Mailbox not found" }, { status: 403 });
	const id = newId("key");
	await db.insert(apiKeys).values({
		id,
		userId: user.id,
		name: parsed.data.name,
		prefix,
		keyHash: hash,
		keySha256: sha256,
		scopes: scopesToJson([...new Set(parsed.data.scopes)]),
		mailboxScopeEnabled: true,
	});
	if (mailboxIds.length) await db.insert(mcpKeyMailboxes).values(mailboxIds.map((mailboxId) => ({ keyId: id, mailboxId })));

	return NextResponse.json({ id, name: parsed.data.name, prefix, key: fullKey, mailboxIds });
}

export async function DELETE(request: Request) {
	const env = getEnv();
	const user = await requireUser(env, request);
	if (!hasValidSessionMutationOrigin(request)) return NextResponse.json({ error: "Invalid origin" }, { status: 403 });
	const id = new URL(request.url).searchParams.get("id");
	if (!id) return NextResponse.json({ error: "Key required" }, { status: 400 });
	const db = getDb(env);
	const [key] = await db.select({ id: apiKeys.id, scopes: apiKeys.scopes }).from(apiKeys).where(and(eq(apiKeys.id, id), eq(apiKeys.userId, user.id))).limit(1);
	if (!key) return NextResponse.json({ error: "Key not found" }, { status: 404 });
	if (parseScopes(key.scopes).some((scope) => (ADMIN_API_KEY_SCOPES as readonly string[]).includes(scope))) return NextResponse.json({ error: "Manage this key in Admin API keys" }, { status: 403 });
	await db.update(agentSendApprovals).set({ status: "cancelled" }).where(and(eq(agentSendApprovals.requestKeyId, id), eq(agentSendApprovals.status, "pending")));
	await db.delete(apiKeys).where(and(eq(apiKeys.id, id), eq(apiKeys.userId, user.id)));
	return NextResponse.json({ ok: true });
}

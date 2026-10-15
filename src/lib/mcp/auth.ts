import { and, eq, lt, or, isNull } from "drizzle-orm";
import { getDb } from "@/db";
import { apiKeys, mcpKeyMailboxes, users } from "@/db/schema";
import { parseScopes, verifyApiKey } from "@/lib/api-keys";
import { getMailboxAccessLevel } from "@/lib/mailboxes/access";
import { ADMIN_API_KEY_SCOPES } from "@/lib/api/scopes";
import type { McpPrincipal } from "./types";

const MCP_SCOPES = new Set(["mcp:read", "mcp:note", "mcp:draft", "mcp:organize", "mcp:request-send", "mcp:calendar-read", "mcp:calendar-write"]);
const ADMIN_SCOPES = new Set<string>(ADMIN_API_KEY_SCOPES);

export async function authenticateMcpRequest(env: CloudflareEnv, request: Request): Promise<McpPrincipal | null> {
	const authorization = request.headers.get("Authorization") ?? "";
	if (!authorization.startsWith("Bearer ")) return null;
	const key = authorization.slice(7).trim();
	if (!key.startsWith("ep_") || key.length > 256) return null;
	const db = getDb(env);
	const candidates = await db.select().from(apiKeys).where(and(eq(apiKeys.prefix, key.slice(0, 12)), eq(apiKeys.kind, "mcp")));
	for (const candidate of candidates) {
		if (!verifyApiKey(key, candidate.keyHash)) continue;
		const allScopes = parseScopes(candidate.scopes);
		const isMailKey = allScopes.length > 0 && allScopes.every((scope) => MCP_SCOPES.has(scope));
		const isAdminKey = allScopes.length > 0 && allScopes.every((scope) => ADMIN_SCOPES.has(scope));
		if (!isMailKey && !isAdminKey) return null;
		const [user] = await db.select().from(users).where(eq(users.id, candidate.userId)).limit(1);
		if (!user || user.disabled) return null;
		if (isAdminKey && user.role !== "admin") return null;
		const allowed = isMailKey ? await db.select({ mailboxId: mcpKeyMailboxes.mailboxId }).from(mcpKeyMailboxes).where(eq(mcpKeyMailboxes.keyId, candidate.id)) : [];
		const mailboxIds: string[] = [];
		for (const { mailboxId } of allowed) if ((await getMailboxAccessLevel(db, user, mailboxId))?.canRead) mailboxIds.push(mailboxId);
		const stale = new Date(Date.now() - 60_000);
		await db.update(apiKeys).set({ lastUsedAt: new Date() }).where(and(eq(apiKeys.id, candidate.id), or(isNull(apiKeys.lastUsedAt), lt(apiKeys.lastUsedAt, stale))));
		return { keyId: candidate.id, user, scopes: allScopes, mailboxIds };
	}
	return null;
}

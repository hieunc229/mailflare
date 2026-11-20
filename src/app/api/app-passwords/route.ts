import { NextResponse } from "next/server";
import { desc, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { apiKeys, mcpKeyMailboxes } from "@/db/schema";
import { generateAppPassword, parseScopes, scopesToJson } from "@/lib/api-keys";
import { requireSessionUser } from "@/lib/api/auth";
import { recordAuthActivity } from "@/lib/auth/activity";
import { availableAppPasswordProtocols } from "@/lib/auth/app-passwords";
import { isListedAsAppPassword } from "@/lib/auth/app-password-utils";
import { hasValidSessionMutationOrigin } from "@/lib/auth/origin";
import { getSessionTokenFromRequestHeaders } from "@/lib/auth/session";
import { consumeStepUpGrant } from "@/lib/auth/webauthn/grants";
import { getEnv } from "@/lib/cloudflare";
import { authError } from "@/lib/http/auth-error";
import { readJsonBody } from "@/lib/http/request";
import { newId } from "@/lib/ids";
import { getMailboxAccessLevel } from "@/lib/mailboxes/access";
import { appPasswordCreateSchema } from "@/lib/validators";

const NO_STORE = { "Cache-Control": "no-store" };

export async function GET(request: Request) {
	const env = getEnv();
	const auth = await requireSessionUser(env, request);
	if (auth.error) return auth.error;
	const rows = await getDb(env)
		.select({
			id: apiKeys.id,
			name: apiKeys.name,
			kind: apiKeys.kind,
			scopes: apiKeys.scopes,
			createdAt: apiKeys.createdAt,
			lastUsedAt: apiKeys.lastUsedAt,
			lastUsedProtocol: apiKeys.lastUsedProtocol,
			lastUsedIp: apiKeys.lastUsedIp,
		})
		.from(apiKeys)
		.where(eq(apiKeys.userId, auth.user.id))
		.orderBy(desc(apiKeys.createdAt));
	const appPasswords = rows
		.filter(isListedAsAppPassword)
		.map(({ kind, scopes, ...row }) => ({ ...row, legacy: kind !== "app", protocols: parseScopes(scopes) }));
	return NextResponse.json({ appPasswords, availableProtocols: await availableAppPasswordProtocols(env) }, { headers: NO_STORE });
}

/**
 * Mint an app password. It signs in without the account password or a second
 * factor, so it needs a fresh step-up grant for exactly this action. Everything
 * is validated before the grant is spent, so a typo does not burn it.
 */
export async function POST(request: Request) {
	const env = getEnv();
	const auth = await requireSessionUser(env, request);
	if (auth.error) return auth.error;
	if (!hasValidSessionMutationOrigin(request)) return NextResponse.json({ error: "Invalid origin" }, { status: 403 });
	const parsed = appPasswordCreateSchema.safeParse(await readJsonBody(request, 16 * 1024).catch(() => null));
	if (!parsed.success) return authError("invalid_request", 400);
	const { name, stepUpToken } = parsed.data;
	const protocols = [...new Set(parsed.data.protocols)];
	const available = await availableAppPasswordProtocols(env);
	if (protocols.some((protocol) => !available.includes(protocol))) return authError("invalid_request", 400);

	const db = getDb(env);
	const mailboxIds = [...new Set(parsed.data.mailboxIds)];
	// Every protocol offered today reads mail, so a mailbox is always needed; `dav` (user-level) will relax this.
	const mailboxScoped = protocols.some((protocol) => protocol !== "dav");
	if (mailboxScoped && !mailboxIds.length) return NextResponse.json({ error: "Choose a mailbox for mail access" }, { status: 400 });
	for (const mailboxId of mailboxIds) if (!(await getMailboxAccessLevel(db, auth.user, mailboxId))?.canRead) return NextResponse.json({ error: "Mailbox not found" }, { status: 403 });

	const sessionToken = getSessionTokenFromRequestHeaders(request);
	if (!stepUpToken || !sessionToken) return authError("verification_required", 400);
	if (!(await consumeStepUpGrant(env, { token: stepUpToken, userId: auth.user.id, sessionToken, action: "app_password.create" }))) {
		return authError("verification_required", 401);
	}

	const { fullKey, prefix, hash, sha256 } = await generateAppPassword();
	const id = newId("key");
	await db.insert(apiKeys).values({
		id,
		kind: "app",
		userId: auth.user.id,
		name,
		prefix,
		keyHash: hash,
		keySha256: sha256,
		scopes: scopesToJson(protocols),
		mailboxScopeEnabled: mailboxScoped,
	});
	if (mailboxScoped) await db.insert(mcpKeyMailboxes).values(mailboxIds.map((mailboxId) => ({ keyId: id, mailboxId })));
	await recordAuthActivity(env, { action: "auth.app_password_created", userId: auth.user.id, request });
	return NextResponse.json({ id, name, key: fullKey, protocols, mailboxIds }, { headers: NO_STORE });
}

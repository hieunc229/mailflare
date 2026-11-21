import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { apiKeys, mcpKeyMailboxes, users } from "@/db/schema";
import { parseScopes } from "@/lib/api-keys";
import type { ApiAuthResult } from "@/lib/api/key-auth-types";
import { allowAppPasswordGuessFrom, authenticateAppPassword } from "@/lib/auth/app-passwords";
import { listJmapMailboxes, listSendableAddresses } from "@/lib/jmap/access";
import type { AccessibleMailbox, JmapContext } from "@/lib/jmap/types";
import { createAuditLog } from "@/lib/mailboxes/audit";

/**
 * Who a mail app is, once it has logged in: the app password (`keyId`, never the
 * secret) and the Mailflare mailbox its username named. Everything else a session
 * may see is looked up again through the access layer when it is needed.
 */
export type ImapIdentity = {
	keyId: string;
	userId: string;
	loginMailboxId: string;
	/** The username as the client wrote it, lower-cased. */
	username: string;
	auth: ApiAuthResult;
};

/** Why a login failed, for the server's log only: the client is told the same thing for every reason but `throttled`. */
export type LoginFailure = "throttled" | "bad_secret" | "no_mailbox" | "malformed";

export type LoginResult = { ok: true; identity: ImapIdentity } | { ok: false; reason: Exclude<LoginFailure, "malformed"> };

/** A JMAP context for one call: no per-request memo, so a long session re-reads mailbox access every time (spec section 5). */
export function imapContext(env: CloudflareEnv, auth: ApiAuthResult): JmapContext {
	return { env, db: getDb(env), auth, accountId: auth.userId, origin: env.APP_URL ?? "", createdIds: {}, memo: null };
}

const MAX_USERNAME = 320;

/**
 * The mailbox a login username names: the user's login e-mail is their primary
 * mailbox, any other address (or alias) must belong to a mailbox the user can
 * access and the app password's mailbox scope allows, which is what the access
 * layer lists.
 */
async function resolveLoginMailbox(ctx: JmapContext, username: string): Promise<AccessibleMailbox | null> {
	if (!username || username.length > MAX_USERNAME) return null;
	const mailboxes = await listJmapMailboxes(ctx);
	if (username === ctx.auth.email.toLowerCase()) return mailboxes.find((mailbox) => mailbox.isPrimary) ?? null;
	const exact = mailboxes.find((mailbox) => `${mailbox.localPart}@${mailbox.hostname}`.toLowerCase() === username);
	if (exact) return exact;
	for (const mailbox of mailboxes) {
		if ((await listSendableAddresses(ctx, mailbox)).includes(username)) return mailbox;
	}
	return null;
}

/** The audit entry for a login is written at most once an hour for each key and address. */
const LOGIN_AUDIT_INTERVAL_MS = 60 * 60 * 1000;
const LOGIN_AUDIT_MAX_ENTRIES = 2000;
const audited = new Map<string, number>();

export function clearLoginAuditMemory(): void {
	audited.clear();
}

async function recordLogin(env: CloudflareEnv, identity: ImapIdentity, ip: string | null, client: string): Promise<void> {
	const now = Date.now();
	const memo = `${identity.keyId}\0${ip ?? ""}`;
	const last = audited.get(memo);
	if (last !== undefined && now - last < LOGIN_AUDIT_INTERVAL_MS) return;
	if (audited.size >= LOGIN_AUDIT_MAX_ENTRIES) {
		for (const [key, at] of audited) if (now - at >= LOGIN_AUDIT_INTERVAL_MS) audited.delete(key);
		if (audited.size >= LOGIN_AUDIT_MAX_ENTRIES) audited.delete(audited.keys().next().value as string);
	}
	audited.set(memo, now);
	try {
		await createAuditLog(env, {
			actorUserId: identity.userId,
			targetUserId: identity.userId,
			mailboxId: identity.loginMailboxId,
			action: "auth.app_password_login",
			metadata: { ipAddress: ip ?? "Unknown", device: "Mail app", platform: client, keyId: identity.keyId },
		});
	} catch (error) {
		// A login must not fail because the audit log is unavailable.
		console.warn("IMAP login audit failed", error);
	}
}

/**
 * LOGIN / AUTHENTICATE PLAIN. The guess budget (shared with DAV and JMAP) is spent
 * before anything is looked up; the app password decides who the user is, and only
 * then is the username matched against what that user may access. A wrong secret,
 * a wrong username, a missing scope, a disabled user and an address outside the
 * key's mailbox scope all end the same way, so a client learns nothing about which
 * accounts or addresses exist. The account password is never accepted.
 */
export async function authenticateImap(env: CloudflareEnv, input: { username: string; secret: string; ip: string | null; client: string }): Promise<LoginResult> {
	if (!(await allowAppPasswordGuessFrom(env, input.ip, input.secret.replace(/[\s-]/g, ""), "app"))) return { ok: false, reason: "throttled" };
	const auth = await authenticateAppPassword(env, { secret: input.secret, protocol: "imap", clientIp: input.ip });
	if (!auth) return { ok: false, reason: "bad_secret" };
	const username = input.username.trim().toLowerCase();
	const mailbox = await resolveLoginMailbox(imapContext(env, auth), username);
	if (!mailbox) return { ok: false, reason: "no_mailbox" };
	const identity: ImapIdentity = { keyId: auth.keyId, userId: auth.userId, loginMailboxId: mailbox.id, username, auth };
	await recordLogin(env, identity, input.ip, input.client);
	return { ok: true, identity };
}

/**
 * Whether the login still stands: the key row exists, is still an app password
 * with the `imap` scope, and its user is not disabled. Reads the primary database,
 * so a replica that lags cannot keep a revoked key alive. Returns the identity with
 * the key's current mailbox scope, or null.
 */
export async function revalidateIdentity(env: CloudflareEnv, identity: ImapIdentity): Promise<ImapIdentity | null> {
	const db = getDb({ DB: env.DB_PRIMARY ?? env.DB });
	const [key] = await db.select().from(apiKeys).where(eq(apiKeys.id, identity.keyId)).limit(1);
	if (!key || key.userId !== identity.userId || key.kind !== "app" || !parseScopes(key.scopes).includes("imap")) return null;
	const [user] = await db.select().from(users).where(eq(users.id, key.userId)).limit(1);
	if (!user || user.disabled) return null;
	const scope = key.mailboxScopeEnabled ? (await db.select({ mailboxId: mcpKeyMailboxes.mailboxId }).from(mcpKeyMailboxes).where(eq(mcpKeyMailboxes.keyId, key.id))).map((row) => row.mailboxId) : null;
	return { ...identity, auth: { ...identity.auth, user, email: user.email, mailboxIds: scope } };
}

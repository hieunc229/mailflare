import { NextResponse } from "next/server";
import type { getDb } from "@/db";
import { externalAccounts } from "@/db/schema";
import type { SessionUser } from "@/lib/auth/types";
import { isExternalAccountCryptoError } from "@/lib/external-accounts/crypto";
import type { ExternalAccountView } from "@/lib/external-accounts/types";
import { getMailboxAccessLevel } from "@/lib/mailboxes/access";

type Db = ReturnType<typeof getDb>;

/** The columns a response may carry. `password_encrypted` and `sync_cursor` are deliberately absent. */
export const externalAccountColumns = {
	id: externalAccounts.id,
	protocol: externalAccounts.protocol,
	host: externalAccounts.host,
	port: externalAccounts.port,
	tlsMode: externalAccounts.tlsMode,
	username: externalAccounts.username,
	enabled: externalAccounts.enabled,
	lastSyncedAt: externalAccounts.lastSyncedAt,
	lastError: externalAccounts.lastError,
	createdAt: externalAccounts.createdAt,
	updatedAt: externalAccounts.updatedAt,
};

export type ExternalAccountRow = Pick<typeof externalAccounts.$inferSelect, keyof typeof externalAccountColumns>;

/**
 * Credentials are mailbox configuration, so they belong to the owner and to delegates with full_access —
 * the same check the mailbox settings routes make. Read-only and send-as delegates get nothing.
 */
export async function requireManagedMailbox(db: Db, user: Pick<SessionUser, "id" | "role" | "isPrimaryAdmin" | "canManageUsers">, mailboxId: string) {
	const access = await getMailboxAccessLevel(db, user, mailboxId);
	if (!access) return { mailbox: null, error: NextResponse.json({ error: "Mailbox not found" }, { status: 404 }) } as const;
	if (!access.canManage) return { mailbox: null, error: NextResponse.json({ error: "You cannot change this mailbox" }, { status: 403 }) } as const;
	return { mailbox: access.mailbox, error: null } as const;
}

/**
 * Masks the stored password as a boolean. A row always has one (`password_encrypted` is NOT NULL and no route
 * clears it), so the flag is exact without ever selecting the ciphertext.
 */
export function externalAccountView(row: ExternalAccountRow): ExternalAccountView {
	return {
		id: row.id,
		protocol: row.protocol,
		host: row.host,
		port: row.port,
		tlsMode: row.tlsMode,
		username: row.username,
		enabled: row.enabled,
		passwordSet: true,
		lastSyncedAt: row.lastSyncedAt?.toISOString() ?? null,
		lastError: row.lastError,
		createdAt: row.createdAt.toISOString(),
		updatedAt: row.updatedAt.toISOString(),
	};
}

/**
 * Turns a crypto failure into a response instead of letting it escape the handler and fail the worker. A
 * missing or too-short key is the operator's to fix, so it is a 503 the caller can retry after configuring it;
 * the message names the env var and never a secret.
 */
export function encryptionErrorResponse(error: unknown) {
	if (!isExternalAccountCryptoError(error)) return null;
	const status = error.code === "secret_decrypt_failed" ? 422 : 503;
	return NextResponse.json({ error: error.message, code: error.code.toUpperCase() }, { status });
}

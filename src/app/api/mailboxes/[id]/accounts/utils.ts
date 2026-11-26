import { NextResponse } from "next/server";
import type { getDb } from "@/db";
import { externalAccounts } from "@/db/schema";
import type { SessionUser } from "@/lib/auth/types";
import { isUniqueConstraintError } from "@/lib/database-errors";
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
 * Credentials are mailbox configuration, so they belong to the owner and to delegates with full_access.
 * This gate is deliberately narrower than `getMailboxSettingsAccess`, which also admits an entitled
 * account-admin: fetching someone else's mail is not the same as renaming their mailbox, and the F36 matrix is
 * owner/full_access only. Widening it needs a product decision, not an implicit reuse.
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
 * A database rejection of a write that carries a sealed credential, reduced to what is safe to report.
 *
 * Drizzle wraps driver failures in `DrizzleQueryError`, whose `message` repeats the statement with its bound
 * parameters and whose `params` array holds them — the sealed password among them. Letting that object escape a
 * route handler puts ciphertext in the runtime's error log, so nothing of the original survives here except the
 * driver's classification (`23514`, `ER_DATA_TOO_LONG`, …), which is a constant, not data.
 */
export class ExternalAccountWriteError extends Error {
	constructor(
		readonly kind: "duplicate" | "rejected",
		readonly driverCode: string | null = null,
	) {
		super(kind === "duplicate" ? "This mailbox already fetches that account" : "The account could not be saved");
		this.name = "ExternalAccountWriteError";
	}
}

/** A short alphanumeric driver code (PostgreSQL `23514`, MySQL `ER_DATA_TOO_LONG`); never a message or a value. */
function driverErrorCode(error: unknown): string | null {
	const seen = new Set<unknown>();
	let current: unknown = error;
	while (current && typeof current === "object" && !seen.has(current)) {
		seen.add(current);
		const code = (current as { code?: unknown }).code;
		if (typeof code === "string" && /^[A-Za-z0-9_]{1,32}$/.test(code)) return code;
		current = (current as { cause?: unknown }).cause;
	}
	return null;
}

/**
 * Runs a credential-bearing write. Unique violations keep their own classification for a 409; every other
 * failure is replaced by `ExternalAccountWriteError`, which carries the driver code and nothing else — never
 * the query, its parameters or any row value.
 */
export async function writeCredential<T>(write: () => Promise<T>): Promise<T> {
	try {
		return await write();
	} catch (error) {
		// Classify before discarding: the unique check walks the cause chain of the same object.
		if (isUniqueConstraintError(error)) throw new ExternalAccountWriteError("duplicate");
		throw new ExternalAccountWriteError("rejected", driverErrorCode(error));
	}
}

/** The response for `ExternalAccountWriteError`; `null` when the error is something else. */
export function credentialWriteErrorResponse(error: unknown) {
	if (!(error instanceof ExternalAccountWriteError)) return null;
	if (error.kind === "duplicate") return NextResponse.json({ error: error.message }, { status: 409 });
	return NextResponse.json({ error: error.message, code: "WRITE_FAILED", driverCode: error.driverCode ?? undefined }, { status: 500 });
}

/**
 * Turns a crypto failure into a response instead of letting it escape the handler and fail the worker. A
 * missing, placeholder or too-short key is the operator's to fix, so it is a 503 the caller can retry after
 * configuring it; a value the helper refuses is the caller's, so it is a 400. The message names the env var and
 * never a secret.
 */
export function encryptionErrorResponse(error: unknown) {
	if (!isExternalAccountCryptoError(error)) return null;
	const status = error.code === "secret_decrypt_failed" ? 422 : error.code === "encryption_key_missing" || error.code === "encryption_key_invalid" ? 503 : 400;
	return NextResponse.json({ error: error.message, code: error.code.toUpperCase() }, { status });
}

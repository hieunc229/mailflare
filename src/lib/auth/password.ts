import bcrypt from "bcryptjs";

/**
 * Accounts that sign in only with passkeys still need a non-null column value:
 * SQLite cannot drop `NOT NULL` without rebuilding a heavily referenced table.
 * The sentinel can never be produced by hashPassword and every verification
 * path rejects it, so it behaves like a missing password.
 */
export const PASSWORDLESS_PASSWORD_HASH = "!passkey-only";

export function hashPassword(password: string): string {
	return bcrypt.hashSync(password, 12);
}

export function hasPasswordHash(hash: string | null | undefined): hash is string {
	return !!hash && hash !== PASSWORDLESS_PASSWORD_HASH && hash.startsWith("$2");
}

export function verifyPassword(password: string, hash: string | null | undefined): boolean {
	if (!hasPasswordHash(hash)) return false;
	return bcrypt.compareSync(password, hash);
}

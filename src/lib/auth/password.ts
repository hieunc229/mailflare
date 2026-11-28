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

// A hash computed once so an unknown account costs the same bcrypt work as a known one.
let dummyHash: Promise<string> | null = null;
const dummy = (): Promise<string> => (dummyHash ??= bcrypt.hash("mailflare-timing-dummy", 12));

/** Non-blocking verifyPassword for sign-in; a missing or passwordless hash still spends a real compare. */
export async function verifyPasswordAsync(password: string, hash: string | null | undefined): Promise<boolean> {
	if (!hasPasswordHash(hash)) {
		await bcrypt.compare(password, await dummy());
		return false;
	}
	return bcrypt.compare(password, hash);
}

export function verifyPassword(password: string, hash: string | null | undefined): boolean {
	if (!hasPasswordHash(hash)) return false;
	return bcrypt.compareSync(password, hash);
}

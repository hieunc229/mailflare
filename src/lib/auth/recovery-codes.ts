import { and, eq, isNull, notInArray } from "drizzle-orm";
import { getDb } from "@/db";
import { mfaRecoveryCodes } from "@/db/schema";
import { newId } from "@/lib/ids";
import { hashSessionToken } from "@/lib/auth/session";

const CODE_COUNT = 8;
/** No 0/O/1/I/L, so a code read off paper cannot be mistyped. */
const CODE_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";

function generateCode(): string {
	const bytes = new Uint8Array(10);
	crypto.getRandomValues(bytes);
	const chars = Array.from(bytes, (byte) => CODE_ALPHABET[byte % CODE_ALPHABET.length]);
	return `${chars.slice(0, 5).join("")}-${chars.slice(5).join("")}`;
}

export function normalizeRecoveryCode(code: string): string {
	return code.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** Replace the user's codes with a fresh set and return them in the clear, once. */
export async function issueRecoveryCodes(env: CloudflareEnv, userId: string): Promise<string[]> {
	const db = getDb(env);
	const codes = Array.from({ length: CODE_COUNT }, generateCode);
	const rows = await Promise.all(
		codes.map(async (code) => ({ id: newId("rc"), userId, codeHash: await hashSessionToken(normalizeRecoveryCode(code)) })),
	);
	// Insert first, then drop the older codes, in one batch. Where the driver cannot hold a transaction (Neon HTTP)
	// a failed insert then leaves the old codes in place instead of none.
	await db.batch([
		db.insert(mfaRecoveryCodes).values(rows),
		db.delete(mfaRecoveryCodes).where(and(eq(mfaRecoveryCodes.userId, userId), notInArray(mfaRecoveryCodes.id, rows.map((row) => row.id)))),
	]);
	return codes;
}

/** Burn a code if it is one of the user's unused ones. */
export async function consumeRecoveryCode(env: CloudflareEnv, userId: string, code: string): Promise<boolean> {
	const db = getDb(env);
	const codeHash = await hashSessionToken(normalizeRecoveryCode(code));
	const [row] = await db
		.select({ id: mfaRecoveryCodes.id })
		.from(mfaRecoveryCodes)
		.where(and(eq(mfaRecoveryCodes.userId, userId), eq(mfaRecoveryCodes.codeHash, codeHash), isNull(mfaRecoveryCodes.usedAt)))
		.limit(1);
	if (!row) return false;
	const used = await db
		.update(mfaRecoveryCodes)
		.set({ usedAt: new Date() })
		.where(and(eq(mfaRecoveryCodes.id, row.id), isNull(mfaRecoveryCodes.usedAt)))
		.returning({ id: mfaRecoveryCodes.id });
	return used.length > 0;
}

export async function countUnusedRecoveryCodes(env: CloudflareEnv, userId: string): Promise<number> {
	const db = getDb(env);
	const rows = await db
		.select({ id: mfaRecoveryCodes.id })
		.from(mfaRecoveryCodes)
		.where(and(eq(mfaRecoveryCodes.userId, userId), isNull(mfaRecoveryCodes.usedAt)));
	return rows.length;
}

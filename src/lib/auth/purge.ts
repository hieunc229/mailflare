import { inArray, lt } from "drizzle-orm";
import { getDb } from "@/db";
import { loginChallenges, passkeyEnrollmentGrants, passwordResetTokens, sessions } from "@/db/schema";

/** Under D1's 100 bound parameters per statement. */
const BATCH_SIZE = 90;
/** Bounds one run: the first run after deploy may face years of expired rows; the next days continue. */
const MAX_BATCHES_PER_TABLE = 50;

/**
 * Deletes sessions, login challenges, password reset tokens and passkey
 * enrolment links that expired before `now`. Nothing reads them after expiry,
 * and without this every login not ended by a logout leaves a row forever.
 * Deleting a session also removes its push subscription (cascade), as logout does.
 * Runs from the daily scheduled handler; one table failing does not stop the rest.
 */
export async function purgeExpiredAuthRows(env: CloudflareEnv, now = new Date()): Promise<void> {
	const db = getDb(env);
	const tables = [
		["sessions", sessions],
		["login_challenges", loginChallenges],
		["password_reset_tokens", passwordResetTokens],
		["passkey_enrollment_grants", passkeyEnrollmentGrants],
	] as const;
	for (const [name, table] of tables) {
		try {
			for (let batch = 0; batch < MAX_BATCHES_PER_TABLE; batch += 1) {
				const expired = await db.select({ id: table.id }).from(table).where(lt(table.expiresAt, now)).limit(BATCH_SIZE);
				if (expired.length === 0) break;
				await db.delete(table).where(inArray(table.id, expired.map((row) => row.id)));
				if (expired.length < BATCH_SIZE) break;
			}
		} catch (error) {
			console.error("Expired auth row purge failed", { table: name, error });
		}
	}
}

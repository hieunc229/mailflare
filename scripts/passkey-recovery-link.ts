/**
 * Issue a one-time passkey recovery link for the primary administrator.
 *
 * Run this only on the server, with the same DATABASE_URL (and APP_URL) the
 * app uses:
 *
 *   npm run auth:recovery-link -- admin@example.com https://mail.example.com
 *
 * The link expires after 30 minutes and can only enrol a new passkey. It is the
 * operator fallback for a sole administrator who has lost every passkey.
 */
import { eq } from "drizzle-orm";
import { createDb } from "@/db";
import { openExternalDatabase } from "@/db/external";
import { users } from "@/db/schema";
import { getDatabaseConfig } from "@/db/with-database";
import { createEnrollmentGrant } from "@/lib/auth/webauthn/grants";
import { hashSessionToken } from "@/lib/auth/session";
import { newId } from "@/lib/ids";

const [email, explicitOrigin] = process.argv.slice(2);
if (!email) {
	console.error("Usage: npm run auth:recovery-link -- <primary-admin-email> [https://public-origin]");
	process.exit(1);
}
const origin = (explicitOrigin ?? process.env.APP_URL ?? "").replace(/\/$/, "");
if (!origin.startsWith("https://") && !origin.startsWith("http://localhost")) {
	console.error("Set APP_URL or pass the public HTTPS origin as the second argument.");
	process.exit(1);
}

// The default deployment has no DATABASE_URL. Rather than pretending this
// script can reach D1, print the exact statement for `wrangler d1 execute`.
if (!process.env.DATABASE_URL?.trim()) {
	const token = newId("peg");
	const tokenHash = await hashSessionToken(token);
	const emailSql = email.trim().toLowerCase().replace(/'/g, "''");
	const id = newId();
	const target = `(SELECT id FROM users WHERE email = '${emailSql}' AND is_primary_admin = 1)`;
	const revoke = `UPDATE passkey_enrollment_grants SET used_at = strftime('%s','now') WHERE used_at IS NULL AND user_id IN ${target};`;
	const insert = `INSERT INTO passkey_enrollment_grants (id, user_id, token_hash, kind, created_by_user_id, expires_at, used_at, created_at) SELECT '${id}', id, '${tokenHash}', 'admin', NULL, strftime('%s','now') + 1800, NULL, strftime('%s','now') FROM users WHERE email = '${emailSql}' AND is_primary_admin = 1;`;
	console.log("No DATABASE_URL: run these two statements against the D1 database, in order, then send the link below.");
	console.log(`npx wrangler d1 execute DB --remote --command "${revoke}"`);
	console.log(`npx wrangler d1 execute DB --remote --command "${insert}"`);
	console.log("The insert affects 0 rows if the address is not the primary administrator.");
	console.log(`Recovery link (valid 30 minutes, single use): ${origin}/setup/passkey?token=${encodeURIComponent(token)}`);
	process.exit(0);
}

const config = getDatabaseConfig(process.env as never);
const external = openExternalDatabase(config, true);
const d1 = external as unknown as D1Database;
try {
	const db = createDb(d1);
	const [user] = await db.select().from(users).where(eq(users.email, email.trim().toLowerCase())).limit(1);
	if (!user) {
		console.error("No account has that email address.");
		process.exitCode = 1;
	} else if (!user.isPrimaryAdmin) {
		console.error("This command only issues recovery links for the primary administrator.");
		process.exitCode = 1;
	} else if (user.disabled || user.deletedAt) {
		console.error("That account is disabled or deleted.");
		process.exitCode = 1;
	} else {
		const token = await createEnrollmentGrant({ DB: d1 } as CloudflareEnv, { userId: user.id, kind: "admin" });
		console.log(`Recovery link for ${user.email} (valid 30 minutes, single use):`);
		console.log(`${origin}/setup/passkey?token=${encodeURIComponent(token)}`);
		console.log("Send it through a trusted channel. It can enrol a passkey but cannot read mail.");
	}
} finally {
	await external.sqlExecutor.close?.();
}

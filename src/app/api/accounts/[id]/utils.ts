import { and, eq, ne } from "drizzle-orm";
import type { getDb } from "@/db";
import { mailboxes, users } from "@/db/schema";
import { hasPasswordHash, hashPassword } from "@/lib/auth/password";
import { bumpSecurityVersion } from "@/lib/auth/webauthn/grants";

export class PasskeyOnlyPasswordError extends Error {
	constructor() {
		super("passkey-only-password");
		this.name = "PasskeyOnlyPasswordError";
	}
}

/** The account's sign-in state changed between the check and the password write. */
export class AccountSecurityChangedError extends Error {
	constructor() {
		super("account-security-changed");
		this.name = "AccountSecurityChangedError";
	}
}

type Db = ReturnType<typeof getDb>;

export async function selectAccountById(db: Db, id: string) {
	const [account] = await db.select().from(users).where(eq(users.id, id)).limit(1);
	return account ?? null;
}

export async function emailBelongsToAnotherAccount(db: Db, accountId: string, email: string) {
	const [account] = await db
		.select({ id: users.id })
		.from(users)
		.where(and(eq(users.email, email), ne(users.id, accountId)))
		.limit(1);
	return !!account;
}

export async function updateAccountCredentials(
	db: Db,
	id: string,
	input: { email?: string; name: string; password: string | null; disabled?: boolean },
) {
	let passwordSnapshot: {
		passwordHash: string;
		securityVersion: number;
		totpEnabled: boolean;
		requireSecondFactor: boolean;
	} | null = null;
	if (input.password) {
		const [target] = await db
			.select({
				passwordHash: users.passwordHash,
				securityVersion: users.securityVersion,
				totpEnabled: users.totpEnabled,
				requireSecondFactor: users.requireSecondFactor,
			})
			.from(users)
			.where(eq(users.id, id))
			.limit(1);
		if (!target) throw new Error("account-not-found");
		// Passwordless accounts must be recovered through a passkey enrolment
		// link, never by silently adding a password that bypasses that policy.
		if (!hasPasswordHash(target.passwordHash)) throw new PasskeyOnlyPasswordError();
		passwordSnapshot = target;
	}
	const values = {
		...(input.email ? { email: input.email.trim().toLowerCase() } : {}),
		name: input.name,
		...(typeof input.disabled === "boolean" ? { disabled: input.disabled } : {}),
		...(input.password ? { passwordHash: hashPassword(input.password) } : {}),
	};
	if (!passwordSnapshot) {
		await db.update(users).set(values).where(eq(users.id, id));
	} else {
		const [updated] = await db
			.update(users)
			.set(values)
			.where(and(
				eq(users.id, id),
				eq(users.passwordHash, passwordSnapshot.passwordHash),
				eq(users.securityVersion, passwordSnapshot.securityVersion),
				eq(users.totpEnabled, passwordSnapshot.totpEnabled),
				eq(users.requireSecondFactor, passwordSnapshot.requireSecondFactor),
			))
			.returning({ id: users.id });
		if (!updated) {
			// Distinguish a concurrent move to passkey-only from any other
			// security change so the route can keep its existing error.
			const [current] = await db
				.select({ passwordHash: users.passwordHash })
				.from(users)
				.where(eq(users.id, id))
				.limit(1);
			if (!current) throw new Error("account-not-found");
			if (!hasPasswordHash(current.passwordHash)) throw new PasskeyOnlyPasswordError();
			throw new AccountSecurityChangedError();
		}
		await bumpSecurityVersion(db, id);
	}

	await db
		.update(mailboxes)
		.set({ displayName: input.name })
		.where(and(eq(mailboxes.userId, id), eq(mailboxes.type, "personal")));
}

import { and, eq, gt, isNull, lt, or, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { authStepUps, passkeyEnrollmentGrants, users } from "@/db/schema";
import { newId } from "@/lib/ids";
import { hashSessionToken } from "@/lib/auth/session";
import type { StepUpAction } from "./step-up-types";

const ENROLLMENT_MINUTES: Record<EnrollmentGrantKind, number> = {
	// A first-run administrator may need to come back later in the same browser
	// (for example after a password-manager prompt), so this outlives a normal
	// settings change.
	setup: 24 * 60,
	recovery: 30,
	admin: 30,
};
const STEP_UP_MINUTES = 10;

export type EnrollmentGrantKind = "setup" | "recovery" | "admin";

/** First-run setup token, kept in an HttpOnly cookie instead of the URL. */
export const SETUP_COOKIE = "ep_setup";

export type EnrollmentGrant = {
	id: string;
	userId: string;
	kind: EnrollmentGrantKind;
	expiresAt: Date;
};

/** The session proved itself before a security change, so the proof is stale. */
export class StaleStepUpProofError extends Error {
	constructor() {
		super("The security state changed while the grant was issued");
		this.name = "StaleStepUpProofError";
	}
}

export async function createEnrollmentGrant(
	env: CloudflareEnv,
	input: { userId: string; kind: EnrollmentGrantKind; createdByUserId?: string | null },
): Promise<string> {
	const db = getDb(env);
	const token = newId("peg");
	// Only one live enrolment link per account: a new one revokes the old one.
	await db
		.update(passkeyEnrollmentGrants)
		.set({ usedAt: new Date() })
		.where(and(eq(passkeyEnrollmentGrants.userId, input.userId), isNull(passkeyEnrollmentGrants.usedAt)));
	await db.insert(passkeyEnrollmentGrants).values({
		id: newId(),
		userId: input.userId,
		tokenHash: await hashSessionToken(token),
		kind: input.kind,
		createdByUserId: input.createdByUserId ?? null,
		expiresAt: new Date(Date.now() + ENROLLMENT_MINUTES[input.kind] * 60 * 1000),
	});
	return token;
}

export async function getEnrollmentGrant(env: CloudflareEnv, token: string): Promise<EnrollmentGrant | null> {
	const db = getDb(env);
	const [row] = await db
		.select()
		.from(passkeyEnrollmentGrants)
		.where(
			and(
				eq(passkeyEnrollmentGrants.tokenHash, await hashSessionToken(token)),
				isNull(passkeyEnrollmentGrants.usedAt),
				gt(passkeyEnrollmentGrants.expiresAt, new Date()),
			),
		)
		.limit(1);
	return row ? { id: row.id, userId: row.userId, kind: row.kind, expiresAt: row.expiresAt } : null;
}

/** Burn a grant after the new credential was verified and stored. */
export async function consumeEnrollmentGrant(env: CloudflareEnv, id: string): Promise<boolean> {
	const db = getDb(env);
	const rows = await db
		.update(passkeyEnrollmentGrants)
		.set({ usedAt: new Date() })
		.where(and(eq(passkeyEnrollmentGrants.id, id), isNull(passkeyEnrollmentGrants.usedAt)))
		.returning({ id: passkeyEnrollmentGrants.id });
	return rows.length > 0;
}

async function currentSecurityVersion(env: CloudflareEnv, userId: string): Promise<number | null> {
	const [row] = await getDb(env).select({ securityVersion: users.securityVersion }).from(users).where(eq(users.id, userId)).limit(1);
	return row?.securityVersion ?? null;
}

export async function createStepUpGrant(
	env: CloudflareEnv,
	input: {
		userId: string;
		sessionToken: string;
		action: StepUpAction;
		targetUserId?: string | null;
		expectedActorSecurityVersion: number;
	},
): Promise<string> {
	const db = getDb(env);
	const targetUserId = input.targetUserId ?? null;
	const actorVersion = await currentSecurityVersion(env, input.userId);
	if (actorVersion === null) throw new Error("The account no longer exists");
	// The proof was obtained from the session snapshot before this call. If the
	// actor changed sign-in methods in between, it must not be rebound to the
	// new version: that would turn an old proof into a grant for a changed account.
	if (actorVersion !== input.expectedActorSecurityVersion) throw new StaleStepUpProofError();
	// The grant must stop working when either side changes its sign-in state.
	// Both versions are stored in the grant and checked again when it is spent.
	// Cleanup of the actor's grants is an extra layer, not the only binding.
	const targetVersion = targetUserId ? await currentSecurityVersion(env, targetUserId) : actorVersion;
	if (targetVersion === null) throw new Error("The account no longer exists");
	const token = newId("sup");
	const [inserted] = await db.insert(authStepUps).values({
		id: newId(),
		userId: input.userId,
		sessionHash: await hashSessionToken(input.sessionToken),
		tokenHash: await hashSessionToken(token),
		purpose: input.action,
		targetUserId,
		securityVersion: targetVersion,
		actorSecurityVersion: actorVersion,
		expiresAt: new Date(Date.now() + STEP_UP_MINUTES * 60 * 1000),
	}).returning({ id: authStepUps.id });
	// A security change may have landed between reading the versions and
	// inserting. A bump deletes existing grants, so without this check the new
	// row could outlive the change it should have invalidated.
	const actorAfter = await currentSecurityVersion(env, input.userId);
	const targetAfter = targetUserId ? await currentSecurityVersion(env, targetUserId) : actorAfter;
	if (!inserted || actorAfter !== input.expectedActorSecurityVersion || targetAfter !== targetVersion) {
		if (inserted) await db.delete(authStepUps).where(eq(authStepUps.id, inserted.id));
		if (actorAfter !== input.expectedActorSecurityVersion) throw new StaleStepUpProofError();
		throw new Error("The security state changed while the grant was issued");
	}
	// Expired grants can never be consumed; dropping them keeps the table small.
	await db.delete(authStepUps).where(lt(authStepUps.expiresAt, new Date()));
	return token;
}

async function grantConditions(input: {
	userId: string;
	sessionToken: string;
	action: StepUpAction;
	targetUserId?: string | null;
}) {
	const targetUserId = input.targetUserId ?? null;
	const target = targetUserId ?? input.userId;
	return and(
		eq(authStepUps.userId, input.userId),
		eq(authStepUps.sessionHash, await hashSessionToken(input.sessionToken)),
		eq(authStepUps.purpose, input.action),
		targetUserId ? eq(authStepUps.targetUserId, targetUserId) : isNull(authStepUps.targetUserId),
		eq(authStepUps.securityVersion, sql`(select ${users.securityVersion} from ${users} where ${users.id} = ${target})`),
		// Bind the actor as well as the target so removal of the actor's
		// authenticator invalidates the grant even if row cleanup fails.
		eq(
			authStepUps.actorSecurityVersion,
			sql`(select ${users.securityVersion} from ${users} where ${users.id} = ${input.userId})`,
		),
	);
}

/**
 * Non-consuming check used before opening a browser ceremony. Completion must
 * still consume the grant atomically.
 */
export async function peekStepUpGrant(
	env: CloudflareEnv,
	input: { token: string; userId: string; sessionToken: string; action: StepUpAction; targetUserId?: string | null },
): Promise<boolean> {
	const [row] = await getDb(env)
		.select({ id: authStepUps.id })
		.from(authStepUps)
		.where(
			and(
				await grantConditions(input),
				eq(authStepUps.tokenHash, await hashSessionToken(input.token)),
				isNull(authStepUps.usedAt),
				gt(authStepUps.expiresAt, new Date()),
			),
		)
		.limit(1);
	return !!row;
}

/**
 * Spends a grant for exactly the action and target it was minted for, and only
 * while the target's security configuration is unchanged. The conditional
 * UPDATE keeps this single-use under concurrency.
 */
export async function consumeStepUpGrant(
	env: CloudflareEnv,
	input: { token: string; userId: string; sessionToken: string; action: StepUpAction; targetUserId?: string | null },
): Promise<boolean> {
	const rows = await getDb(env)
		.update(authStepUps)
		.set({ usedAt: new Date() })
		.where(
			and(
				await grantConditions(input),
				eq(authStepUps.tokenHash, await hashSessionToken(input.token)),
				isNull(authStepUps.usedAt),
				gt(authStepUps.expiresAt, new Date()),
			),
		)
		.returning({ id: authStepUps.id });
	return rows.length > 0;
}

/** Invalidates every outstanding grant once sign-in methods change. */
export async function bumpSecurityVersion(db: ReturnType<typeof getDb>, userId: string): Promise<void> {
	// Increment before deleting: createStepUpGrant compares the actor version
	// again after its insert, so a grant inserted after this delete but before
	// the version is visible is still rejected by that post-insert check.
	await db
		.update(users)
		.set({ securityVersion: sql`${users.securityVersion} + 1` })
		.where(eq(users.id, userId));
	// Grants minted by this user (actor) and for this user (target) both become
	// invalid. The actor binding in grantConditions is authoritative; this
	// deletion is cleanup and cannot be relied on alone.
	await db.delete(authStepUps).where(or(eq(authStepUps.userId, userId), eq(authStepUps.targetUserId, userId)));
}

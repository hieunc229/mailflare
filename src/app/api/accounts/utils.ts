import { and, desc, eq, inArray } from "drizzle-orm";
import { NextResponse } from "next/server";
import type { getDb } from "@/db";
import { domains, mailboxes, users } from "@/db/schema";
import { assertAdmin } from "@/lib/auth/admin";
import { requireUser } from "@/lib/auth/cookies";
import { getLicenseEntitlements } from "@/lib/licenses/service";
import { getEnv } from "@/lib/cloudflare";

type Db = ReturnType<typeof getDb>;

export function listAccountsForAdmin(db: Db) {
	return db
		.select({
			id: users.id,
			email: users.email,
			name: users.name,
			resetEmail: users.resetEmail,
			role: users.role,
			isPrimaryAdmin: users.isPrimaryAdmin,
			disabled: users.disabled,
			avatarKey: users.avatarKey,
			canManageMailboxes: users.canManageMailboxes,
			canManageDomains: users.canManageDomains,
			canManageUsers: users.canManageUsers,
			createdAt: users.createdAt,
			lastSignInAt: users.lastSignInAt,
			deletedAt: users.deletedAt,
		})
		.from(users)
		.orderBy(desc(users.createdAt));
}

export async function getAllowedDomainOwnerIdsForAdmin(db: Db, adminUserId: string): Promise<string[] | null> {
	const [actor] = await db
		.select({ id: users.id, role: users.role, isPrimaryAdmin: users.isPrimaryAdmin, createdByUserId: users.createdByUserId })
		.from(users)
		.where(eq(users.id, adminUserId))
		.limit(1);

	// STRICT SECURITY: Sirf Admin ke liye chalay ga, regular user ko null (Forbidden) return karega
	if (!actor || actor.role !== "admin") return null;

	const [primaryAdmin] = await db
		.select({ id: users.id })
		.from(users)
		.where(eq(users.isPrimaryAdmin, true))
		.limit(1);

	return Array.from(
		new Set(
			[actor.id, actor.createdByUserId, primaryAdmin?.id].filter(
				(id): id is string => typeof id === "string" && id.length > 0,
			),
		),
	);
}

export async function getDomainForAdmin(db: Db, adminUserId: string, domainId: string) {
	const allowedOwnerIds = await getAllowedDomainOwnerIdsForAdmin(db, adminUserId);
	if (!allowedOwnerIds || allowedOwnerIds.length === 0) return null;

	const [domain] = await db
		.select()
		.from(domains)
		.where(and(eq(domains.id, domainId), inArray(domains.userId, allowedOwnerIds)))
		.limit(1);
	return domain ?? null;
}

export async function getExistingMailbox(db: Db, domainId: string, localPart: string) {
	const [mailbox] = await db
		.select()
		.from(mailboxes)
		.where(and(eq(mailboxes.domainId, domainId), eq(mailboxes.localPart, localPart)))
		.limit(1);
	return mailbox ?? null;
}

export function accountListItemFromUser(user: {
	id: string;
	email: string;
	name: string;
	resetEmail: string | null;
	role: "admin" | "user";
	isPrimaryAdmin?: boolean;
	disabled: boolean;
	avatarKey?: string | null;
	canManageMailboxes?: boolean;
	canManageDomains?: boolean;
	canManageUsers?: boolean;
	createdAt: Date;
	lastSignInAt?: Date | null;
	deletedAt?: Date | null;
}) {
	return {
		id: user.id,
		email: user.email,
		name: user.name,
		resetEmail: user.resetEmail,
		role: user.role,
		isPrimaryAdmin: !!user.isPrimaryAdmin,
		disabled: user.disabled,
		hasAvatar: !!user.avatarKey,
		canManageMailboxes: !!user.canManageMailboxes,
		canManageDomains: !!user.canManageDomains,
		canManageUsers: !!user.canManageUsers,
		createdAt: user.createdAt,
		lastSignInAt: user.lastSignInAt ?? null,
		deletedAt: user.deletedAt ?? null,
	};
}

/** Admin session on an installation licensed for Team-only mailbox sharing. */
export async function requireTeamSharingAdmin(request: Request) {
	const access = await requireTeamAdmin(request);
	if (access.error) return access;
	if (!(await getLicenseEntitlements(access.env)).canShareMailboxes) {
		return { ...access, error: NextResponse.json({ error: "A Team license is required to share inboxes" }, { status: 403 }) };
	}
	return access;
}

export async function requireTeamAdmin(request: Request) {
	const env = getEnv();
	try {
		const user = await requireUser(env, request);
		assertAdmin(user);
		if (!(await getLicenseEntitlements(env)).canManageAccounts) {
			return {
				env,
				user,
				error: NextResponse.json({ error: "A Pro or Team license is required to manage accounts" }, { status: 403 }),
			};
		}
		return { env, user, error: null };
	} catch {
		return { env, user: null, error: NextResponse.json({ error: "Forbidden" }, { status: 403 }) };
	}
}

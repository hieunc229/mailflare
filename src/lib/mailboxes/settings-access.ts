import { and, eq, isNull } from "drizzle-orm";
import { getDb } from "@/db";
import { mailboxes, users } from "@/db/schema";
import { canManageUserAccount, canManageUsers } from "@/lib/auth/admin";
import type { SessionUser } from "@/lib/auth/types";
import { getLicenseEntitlements } from "@/lib/licenses/service";
import { getMailboxAccessLevel } from "./access";

/** Configuration access does not grant permission to read or send mail. */
export async function getMailboxSettingsAccess(
	env: CloudflareEnv,
	user: Pick<SessionUser, "id" | "role" | "isPrimaryAdmin" | "canManageUsers">,
	mailboxId: string,
) {
	const db = getDb(env);
	const access = await getMailboxAccessLevel(db, user, mailboxId);
	if (access?.canManage || !canManageUsers(user)) return access;

	const [owner] = await db
		.select({ role: users.role, isPrimaryAdmin: users.isPrimaryAdmin })
		.from(mailboxes)
		.innerJoin(users, eq(mailboxes.userId, users.id))
		.where(and(eq(mailboxes.id, mailboxId), eq(mailboxes.disabled, false), isNull(users.deletedAt)))
		.limit(1);
	if (!owner || !canManageUserAccount(user, owner) || !(await getLicenseEntitlements(env)).canManageAccounts) {
		return access;
	}

	return { permission: access?.permission ?? null, canRead: true, canManage: true };
}

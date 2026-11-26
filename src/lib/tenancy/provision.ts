import { and, eq, isNull } from "drizzle-orm";
import { getDb } from "@/db";
import { mailboxes, users } from "@/db/schema";
import { PASSWORDLESS_PASSWORD_HASH } from "@/lib/auth/password";
import { hasAdminAccount } from "@/lib/auth/setup";
import { ensureBookingUsername } from "@/lib/booking/username";
import { isUniqueConstraintError } from "@/lib/database-errors";
import { addDomainForUser } from "@/lib/domains/service";
import { newId } from "@/lib/ids";
import { ensureMailboxDomainRouting } from "@/lib/mailboxes/domain-addresses";
import type { TenantInfo } from "./types";

const done = new Set<string>();

/**
 * A hosted workspace is created by signing up for it, so its administrator exists from the first request:
 * the first-run setup screens never appear. The account, its domain and its mailbox are what first-run
 * registration would create, minus the DNS step (customer domains are set up by hand).
 */
export async function ensureTenantAdmin(env: CloudflareEnv, tenant: TenantInfo): Promise<void> {
	if (done.has(tenant.id) || !tenant.adminEmail) return;
	if (await hasAdminAccount(env)) {
		// Workspaces created before the recovery address was passed in: without one, "Forgot password" sends nothing.
		if (tenant.contactEmail) await getDb(env).update(users).set({ resetEmail: tenant.contactEmail }).where(and(eq(users.isPrimaryAdmin, true), isNull(users.resetEmail)));
		done.add(tenant.id);
		return;
	}
	const [username, domainName] = tenant.adminEmail.toLowerCase().split("@");
	const db = getDb(env);
	const userId = newId("usr");
	try {
		await db.insert(users).values({
			id: userId,
			remoteContentMode: "ask",
			email: tenant.adminEmail.toLowerCase(),
			resetEmail: tenant.contactEmail,
			passwordHash: tenant.adminPasswordHash ?? PASSWORDLESS_PASSWORD_HASH,
			name: tenant.adminName?.trim() || username,
			role: "admin",
			isPrimaryAdmin: true,
		});
	} catch (error) {
		if (isUniqueConstraintError(error)) return; // another request created it first
		throw error;
	}
	try {
		await ensureBookingUsername(env, userId, tenant.adminEmail);
		const { domain } = await addDomainForUser(env, userId, domainName || tenant.domain, { enableRouting: true, enableSending: true, skipDns: true, skipPlanLimit: true });
		const mailboxId = newId("mbx");
		await db.insert(mailboxes).values({ id: mailboxId, userId, domainId: domain.id, localPart: username, displayName: username });
		await ensureMailboxDomainRouting(env, db, { id: mailboxId, domainId: domain.id, localPart: username, useAllDomains: true });
	} catch (error) {
		await db.delete(users).where(eq(users.id, userId)).catch(() => undefined); // retry on the next request
		throw error;
	}
	done.add(tenant.id);
}

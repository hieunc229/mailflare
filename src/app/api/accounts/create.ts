import { and, eq, inArray } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { domains, mailboxAliases, mailboxes, users } from "@/db/schema";
import { hashPassword } from "@/lib/auth/password";
import { rollbackEmailRoutingRuleChanges } from "@/lib/cloudflare-api";
import type { CfEmailRoutingRuleChange } from "@/lib/cloudflare-api.types";
import { normalizeRecipientLocalPart } from "@/lib/email/recipient-address";
import { newId } from "@/lib/ids";
import { ensureMailboxDomainRouting } from "@/lib/mailboxes/domain-addresses";
import type { CreateUserAccountInput } from "./types";
import { accountListItemFromUser, getDomainForAdmin } from "./utils";

/** Shared by dashboard and admin API/MCP account creation. */
export async function createAccountResponse(env: CloudflareEnv, adminUserId: string, input: CreateUserAccountInput) {
	const db = getDb(env);
	const primaryDomain = await getDomainForAdmin(db, adminUserId, input.domainId);
	if (!primaryDomain) return NextResponse.json({ error: "Domain not found" }, { status: 404 });
	const username = input.username.toLowerCase().trim();
	const email = `${username}@${primaryDomain.hostname}`;
	const requested = [{ domainId: primaryDomain.id, localPart: username }, ...input.aliases];
	const domainIds = [...new Set(requested.map((address) => address.domainId))];
	const ownedDomains = await db.select().from(domains).where(and(
		eq(domains.userId, adminUserId), inArray(domains.id, domainIds),
	));
	const byId = new Map(ownedDomains.map((domain) => [domain.id, domain]));
	const seen = new Set<string>();
	for (const [index, address] of requested.entries()) {
		const domain = byId.get(address.domainId);
		if (!domain || (index > 0 && domain.status !== "active")) {
			return NextResponse.json({ error: "Choose an active alias domain owned by this admin account" }, { status: 400 });
		}
		const localPart = normalizeRecipientLocalPart(address.localPart);
		if (!localPart) return NextResponse.json({ error: "Enter a valid address username" }, { status: 400 });
		const key = `${localPart}@${domain.id}`;
		if (seen.has(key)) {
			return NextResponse.json({ error: "Each alias must be distinct from the primary address and other aliases" }, { status: 400 });
		}
		seen.add(key);
	}
	const [registered] = await db.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1);
	if (registered) return NextResponse.json({ error: "Email already registered" }, { status: 409 });
	const [existingMailboxes, existingAliases] = await Promise.all([
		db.select({ domainId: mailboxes.domainId, localPart: mailboxes.localPart }).from(mailboxes).where(inArray(mailboxes.domainId, domainIds)),
		db.select({ domainId: mailboxAliases.domainId, localPart: mailboxAliases.localPart }).from(mailboxAliases).where(inArray(mailboxAliases.domainId, domainIds)),
	]);
	if ([...existingMailboxes, ...existingAliases].some((address) => seen.has(`${normalizeRecipientLocalPart(address.localPart)}@${address.domainId}`))) {
		return NextResponse.json({ error: "An email address is already assigned to a mailbox or alias" }, { status: 409 });
	}

	const userId = newId("usr");
	const mailboxId = newId("mbx");
	const mailbox = { id: mailboxId, userId, domainId: primaryDomain.id, localPart: username, displayName: username, useAllDomains: input.useAllDomains };
	const changes: CfEmailRoutingRuleChange[] = [];
	let inserted = false;
	try {
		const accountInsert = db.insert(users).values({
			id: userId, email, passwordHash: hashPassword(input.password), name: username,
			role: input.role, createdByUserId: adminUserId,
		}).returning();
		const mailboxInsert = db.insert(mailboxes).values(mailbox);
		// D1 batches are atomic: aliases and their owner either all exist or none do.
		// Separate alias statements stay below D1's per-statement parameter limit.
		const [accounts] = await db.batch([accountInsert, mailboxInsert, ...input.aliases.map((alias) => db.insert(mailboxAliases).values({
				id: newId("als"), mailboxId, domainId: alias.domainId, localPart: alias.localPart,
			}))]);
		inserted = true;
		await ensureMailboxDomainRouting(env, db, mailbox, changes);
		return NextResponse.json({ account: accountListItemFromUser(accounts[0]) }, { status: 201 });
	} catch (error) {
		const cleanup = await Promise.allSettled([
			rollbackEmailRoutingRuleChanges(env, changes),
			...(inserted ? [db.delete(users).where(eq(users.id, userId))] : []),
		]);
		if (cleanup.some((result) => result.status === "rejected")) {
			return NextResponse.json({ error: "Account creation failed and cleanup could not finish. Check the account and Cloudflare routing before retrying." }, { status: 502 });
		}
		const cause = error instanceof Error ? error.cause : null;
		if (/UNIQUE constraint failed/i.test(`${error} ${cause}`)) {
			return NextResponse.json({ error: "An email address is already assigned" }, { status: 409 });
		}
		return NextResponse.json({ error: "Failed to create account mailbox routing. Please try again." }, { status: 502 });
	}
}

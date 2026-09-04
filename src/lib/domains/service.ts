import { eq, and } from "drizzle-orm";
import { getDb } from "@/db";
import { domains, mailboxes } from "@/db/schema";
import { ensureMailboxDomainRouting } from "@/lib/mailboxes/domain-addresses";
import { newId } from "@/lib/ids";
import {
	disableEmailRouting,
	getEmailRoutingDns,
	getEmailRoutingSettings,
	getSendingSubdomainDns,
	deleteSendingSubdomain,
	listSendingSubdomains,
	type CfDnsRecord,
} from "@/lib/cloudflare-api";
import { deleteEmailRoutingRulesForDomain } from "@/lib/domains/cloudflare-cleanup";
import { provisionDomainOnCloudflare } from "@/lib/domains/provision";
import { rollbackDomainProvisioning } from "@/lib/domains/rollback";
import type { DomainProvisioningChanges } from "@/lib/domains/types";
import { findSendingSubdomain } from "@/lib/domains/sending-status";

export type DomainDnsView = {
	routing: { records: CfDnsRecord[]; missing: CfDnsRecord[]; status?: string };
	sending: CfDnsRecord[];
	sendingEnabled: boolean;
};

export async function listUserDomains(env: CloudflareEnv, userId: string) {
	const db = getDb(env);
	return db.select().from(domains).where(eq(domains.userId, userId));
}

export async function addDomainForUser(
	env: CloudflareEnv,
	userId: string,
	hostname: string,
	options?: { enableRouting?: boolean; enableSending?: boolean },
): Promise<{
	domain: typeof domains.$inferSelect;
	dns: DomainDnsView;
	changes: DomainProvisioningChanges;
}> {
	const provisioned = await provisionDomainOnCloudflare(env, hostname, options);
	const db = getDb(env);
	let insertedDomainId: string | null = null;
	let domain: typeof domains.$inferSelect;

	try {
		const [existing] = await db.select().from(domains).where(eq(domains.hostname, provisioned.hostname)).limit(1);
		if (existing && existing.userId !== userId) {
			throw new Error("Domain is already registered");
		}

		const domainId = existing?.id ?? newId("dom");
		const values = {
			id: domainId,
			userId,
			hostname: provisioned.hostname,
			zoneId: provisioned.zone.id,
			status: provisioned.routingEnabled || provisioned.sendingEnabled ? ("active" as const) : ("pending" as const),
			routingStatus: provisioned.routingStatus ?? null,
			sendingSubdomainTag: provisioned.sendingSubdomainTag,
			sendingEnabled: provisioned.sendingEnabled,
			routingEnabled: provisioned.routingEnabled,
		};

		if (existing) {
			await db.update(domains).set(values).where(eq(domains.id, domainId));
		} else {
			await db.insert(domains).values(values);
			insertedDomainId = domainId;
		}

		const aliasMailboxes = await db
			.select({ id: mailboxes.id, domainId: mailboxes.domainId, localPart: mailboxes.localPart, useAllDomains: mailboxes.useAllDomains })
			.from(mailboxes)
			.innerJoin(domains, eq(mailboxes.domainId, domains.id))
			.where(and(eq(domains.userId, userId), eq(mailboxes.useAllDomains, true)));
		const routingResults = await Promise.allSettled(
			aliasMailboxes.map((mailbox) => ensureMailboxDomainRouting(env, db, mailbox)),
		);
		for (const result of routingResults) {
			if (result.status === "rejected") console.warn("ensureMailboxDomainRouting", result.reason);
		}

		const [row] = await db.select().from(domains).where(eq(domains.id, domainId)).limit(1);
		domain = row!;
	} catch (err) {
		// The zone was already provisioned above. Anything that fails after that —
		// a hostname owned by another user, an unmigrated D1 schema — would otherwise
		// strand Email Routing and the sending subdomain with nothing referencing them.
		await rollbackDomainProvisioning(env, provisioned.changes);
		if (insertedDomainId) {
			try {
				await db.delete(domains).where(eq(domains.id, insertedDomainId));
			} catch (cleanupError) {
				console.warn("addDomainForUser: failed to remove partial domain row", cleanupError);
			}
		}
		throw err;
	}

	// Read the DNS view outside the rollback scope: the domain is fully set up by
	// now, so a failed status read must not tear it back down.
	const dns = await getDomainDns(env, domain);
	return { domain, dns, changes: provisioned.changes };
}

export async function getDomainDns(
	env: CloudflareEnv,
	domain: typeof domains.$inferSelect,
): Promise<DomainDnsView> {
	const [routingDns, routingSettings, sendingSubdomains] = await Promise.all([
		getEmailRoutingDns(env, domain.zoneId),
		getEmailRoutingSettings(env, domain.zoneId),
		listSendingSubdomains(env, domain.zoneId),
	]);
	const sendingSubdomain = findSendingSubdomain(domain.hostname, sendingSubdomains);
	let sending: CfDnsRecord[] = [];
	if (sendingSubdomain?.tag) {
		sending = await getSendingSubdomainDns(env, domain.zoneId, sendingSubdomain.tag);
	}
	return {
		routing: {
			records: routingDns.records,
			missing: routingDns.missing,
			status: routingSettings.status,
		},
		sending,
		sendingEnabled: sendingSubdomain?.enabled ?? false,
	};
}

export async function removeDomainForUser(
	env: CloudflareEnv,
	userId: string,
	domainId: string,
): Promise<void> {
	const db = getDb(env);
	const [domain] = await db
		.select()
		.from(domains)
		.where(and(eq(domains.id, domainId), eq(domains.userId, userId)))
		.limit(1);
	if (!domain) throw new Error("Domain not found");

	try {
		await deleteEmailRoutingRulesForDomain(env, domain.zoneId, domain.hostname);
	} catch (err) {
		console.warn("deleteEmailRoutingRulesForDomain", err);
	}

	if (domain.routingEnabled) {
		try {
			await disableEmailRouting(env, domain.zoneId);
		} catch (err) {
			console.warn("disableEmailRouting", err);
		}
	}

	if (domain.sendingSubdomainTag) {
		try {
			await deleteSendingSubdomain(env, domain.zoneId, domain.sendingSubdomainTag);
		} catch (err) {
			console.warn("deleteSendingSubdomain", err);
		}
	}

	await db.delete(domains).where(eq(domains.id, domainId));
}

export async function getDomainForUser(env: CloudflareEnv, userId: string, domainId: string) {
	const db = getDb(env);
	const [domain] = await db
		.select()
		.from(domains)
		.where(and(eq(domains.id, domainId), eq(domains.userId, userId)))
		.limit(1);
	return domain ?? null;
}

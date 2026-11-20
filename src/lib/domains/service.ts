import { eq, and, ne, inArray } from "drizzle-orm";
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
	type EmailRoutingRuleCache,
} from "@/lib/cloudflare-api";
import { deleteEmailRoutingRulesForDomain } from "@/lib/domains/cloudflare-cleanup";
import { isManualZone, provisionDomainOnCloudflare } from "@/lib/domains/provision";
import { getManualDomainDns } from "@/lib/domains/manual-dns";
import { rollbackDomainProvisioning } from "@/lib/domains/rollback";
import type { DomainProvisioningChanges } from "@/lib/domains/types";
import { findSendingSubdomain } from "@/lib/domains/sending-status";
import { preflightDomain } from "@/lib/domains/preflight";
import { normalizeHostname } from "@/lib/domains/utils";
import { hasCloudflareCredentials } from "@/lib/runtime";
import { createAuditLog } from "@/lib/mailboxes/audit";
import { assertDomainRemovable, assertMxChangeAllowed, ForceDeleteConfirmError, forceCleanupMtaSts, type ForceCleanup, republishMtaStsAfterMxChange } from "@/lib/deliverability/mta-sts-guard";

export type DomainDnsView = {
	routing: { records: CfDnsRecord[]; missing: CfDnsRecord[]; status?: string };
	sending: CfDnsRecord[];
	sendingEnabled: boolean;
	/** DKIM selector Cloudflare signs with, when a sending subdomain exists. */
	dkimSelector?: string;
	/** The matching sending subdomain, when the zone has the domain added for sending. */
	sendingSubdomain?: { name: string; tag: string };
};

export async function listUserDomains(env: CloudflareEnv, userIds: string | string[]) {
	const db = getDb(env);
	const ids = Array.isArray(userIds) ? userIds : [userIds];
	return db.select().from(domains).where(ids.length === 1 ? eq(domains.userId, ids[0]) : inArray(domains.userId, ids));
}

export async function addDomainForUser(
	env: CloudflareEnv,
	userId: string,
	hostname: string,
	options?: { enableRouting?: boolean; enableSending?: boolean; replaceMxRecords?: boolean; skipDns?: boolean; receivingProvider?: "none" | "cloudflare" | "resend" | "ses"; sendingProvider?: "none" | "cloudflare" | "resend" | "ses" },
): Promise<{
	domain: typeof domains.$inferSelect;
	dns: DomainDnsView;
	changes: DomainProvisioningChanges;
}> {
	const db = getDb(env);
	const normalizedHostname = normalizeHostname(hostname);
	const [claimedHostname] = await db.select({ id: domains.id, userId: domains.userId }).from(domains).where(eq(domains.hostname, normalizedHostname)).limit(1);
	if (claimedHostname && claimedHostname.userId !== userId) {
		throw new Error("Domain is already registered");
	}
	// A re-add provisions the zone again (MX records, Email Routing, receiving provider), so it is an MX change like any other.
	if (claimedHostname) await assertMxChangeAllowed(env, claimedHostname);
	if (!options?.skipDns && hasCloudflareCredentials(env)) {
		const { zone } = await preflightDomain(env, normalizedHostname);
		const [claimedZone] = await db.select({ userId: domains.userId }).from(domains).where(and(
			eq(domains.zoneId, zone.id),
			ne(domains.userId, userId),
		)).limit(1);
		if (claimedZone) {
			throw new Error("Cloudflare zone is already registered to another account");
		}
	}
	// Email Routing is Cloudflare's way of receiving; another provider brings its own MX,
	// which its setup in the domain page creates once credentials exist.
	// A skipped-DNS domain is recorded only: nothing receives or sends until the operator picks providers.
	const skipDns = options?.skipDns === true;
	const receivingProvider = skipDns ? "none" : (options?.receivingProvider ?? "cloudflare");
	// Cloudflare's sending subdomain is only provisioned when Cloudflare is the sender.
	const requestedSending = skipDns ? "none" : (options?.sendingProvider ?? (options?.enableSending === false ? "none" : "cloudflare"));
	const provisioned = await provisionDomainOnCloudflare(env, hostname, {
		...options,
		enableSending: requestedSending === "cloudflare",
		enableRouting: receivingProvider === "cloudflare" ? (options?.enableRouting ?? true) : false,
		// Routing is skipped for other receivers, so this only reaches the sending step then.
		replaceMxRecords: options?.replaceMxRecords,
	});
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
			status: !skipDns && (provisioned.routingEnabled || provisioned.sendingEnabled || receivingProvider !== "cloudflare") ? ("active" as const) : ("pending" as const),
			receivingProvider,
			routingStatus: provisioned.routingStatus ?? null,
			sendingSubdomainTag: provisioned.sendingSubdomainTag,
			sendingRequested: skipDns ? false : provisioned.sendingRequested,
			...(skipDns ? { sendingProvider: "none" as const } : options?.sendingProvider ? { sendingProvider: options.sendingProvider } : existing && existing.sendingProvider !== "none" ? {} : { sendingProvider: provisioned.sendingRequested ? ("cloudflare" as const) : ("none" as const) }),
			sendingEnabled: skipDns ? false : provisioned.sendingEnabled,
			routingEnabled: skipDns ? false : provisioned.routingEnabled,
			dnsSkipped: options?.skipDns === true,
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
		const ruleCache: EmailRoutingRuleCache = new Map();
		const routingResults = await Promise.allSettled(
			aliasMailboxes.map((mailbox) => ensureMailboxDomainRouting(env, db, mailbox, undefined, ruleCache)),
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

	if (claimedHostname) await republishMtaStsAfterMxChange(env, domain);

	// Read the DNS view outside the rollback scope: the domain is fully set up by
	// now, so a failed status read must not tear it back down or make registration
	// delete the account that now owns the completed Cloudflare configuration.
	let dns: DomainDnsView;
	try {
		dns = await getDomainDns(env, domain);
	} catch (error) {
		console.warn("addDomainForUser: failed to read DNS status after provisioning", error);
		dns = {
			routing: { records: [], missing: [], status: provisioned.routingStatus },
			sending: [],
			sendingEnabled: provisioned.sendingEnabled,
		};
	}
	return { domain, dns, changes: provisioned.changes };
}

export async function getDomainDns(
	env: CloudflareEnv,
	domain: typeof domains.$inferSelect,
): Promise<DomainDnsView> {
	if (isManualZone(domain.zoneId)) return getManualDomainDns(env, domain.hostname);
	// Read the zone's actual sending state rather than trusting `sendingRequested`,
	// which goes stale when sending is enabled outside Mailflare (or when the row
	// was written before the subdomain existed). A missing Email Sending permission
	// must not take down the routing/DNS view, so a failed list degrades to none.
	const [routingDns, routingSettings, sendingSubdomains] = await Promise.all([
		getEmailRoutingDns(env, domain.zoneId),
		getEmailRoutingSettings(env, domain.zoneId),
		listSendingSubdomains(env, domain.zoneId).catch((error) => {
			console.warn("getDomainDns: failed to list sending subdomains", error);
			return [];
		}),
	]);
	const sendingSubdomain = findSendingSubdomain(domain.hostname, sendingSubdomains);
	let sending: CfDnsRecord[] = [];
	if (sendingSubdomain?.tag) {
		sending = await getSendingSubdomainDns(env, domain.zoneId, sendingSubdomain.tag).catch(
			(error) => {
				console.warn("getDomainDns: failed to read sending subdomain DNS", error);
				return [];
			},
		);
	}
	return {
		routing: {
			records: routingDns.records,
			missing: routingDns.missing,
			status: routingSettings.status,
		},
		sending,
		sendingEnabled: sendingSubdomain?.enabled ?? false,
		dkimSelector: sendingSubdomain?.dkim_selector,
		sendingSubdomain: sendingSubdomain
			? { name: sendingSubdomain.name, tag: sendingSubdomain.tag }
			: undefined,
	};
}

export async function removeDomainForUser(
	env: CloudflareEnv,
	userId: string,
	domainId: string,
	force?: { confirm: unknown },
): Promise<ForceCleanup> {
	const db = getDb(env);
	const [domain] = await db
		.select()
		.from(domains)
		.where(and(eq(domains.id, domainId), eq(domains.userId, userId)))
		.limit(1);
	if (!domain) throw new Error("Domain not found");
	let cleanup: ForceCleanup = { leftovers: [], cachedUntil: null };
	if (force) {
		// The admin typed the host name to skip the MTA-STS checks: clean up what DNS allows, report the rest, delete anyway.
		if (typeof force.confirm !== "string" || force.confirm.trim().toLowerCase() !== domain.hostname) {
			throw new ForceDeleteConfirmError(`Type the domain name (${domain.hostname}) to confirm the forced delete`);
		}
		cleanup = await forceCleanupMtaSts(env, domain);
		await createAuditLog(env, { actorUserId: userId, action: "domain.force_delete", metadata: { hostname: domain.hostname, leftovers: cleanup.leftovers.map((record) => record.name), cachedUntil: cleanup.cachedUntil } });
	} else {
		// A published MTA-STS policy and our TLS-RPT address come off first (MtaStsBlockedError, 409 in the routes).
		await assertDomainRemovable(env, domain);
	}

	try {
		await deleteEmailRoutingRulesForDomain(env, domain.zoneId, domain.hostname);
	} catch (err) {
		console.warn("deleteEmailRoutingRulesForDomain", err);
	}

	const [otherDomainOnZone] = await db.select({ id: domains.id }).from(domains).where(and(
		eq(domains.zoneId, domain.zoneId),
		ne(domains.id, domainId),
	)).limit(1);
	if (domain.routingEnabled && !otherDomainOnZone) {
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
	return cleanup;
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

/**
 * Columns to write when the operator flips the "DNS skipped" flag. A skipped
 * domain on the manual zone was stored as pending, and nothing else activates
 * it without Cloudflare credentials, so confirming the records are in place
 * makes it live the way a manual domain added without skipping already is.
 */
export function dnsSkippedUpdate(domain: typeof domains.$inferSelect, dnsSkipped: boolean): Partial<typeof domains.$inferInsert> {
	if (dnsSkipped || !isManualZone(domain.zoneId) || domain.status === "active") return { dnsSkipped };
	return { dnsSkipped, status: "active", routingEnabled: true, routingStatus: "manual" };
}

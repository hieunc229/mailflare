import { and, eq, ne, or } from "drizzle-orm";
import { getDb } from "@/db";
import { domains, mailboxes } from "@/db/schema";
import { disableEmailRouting, type EmailRoutingRuleCache } from "@/lib/cloudflare-api";
import { deleteDnsRecord } from "@/lib/cloudflare-dns";
import { deleteEmailRoutingRulesForDomain } from "@/lib/domains/cloudflare-cleanup";
import { removeMxRecords, restoreMxRecordsAfterFailure } from "@/lib/domains/mx-records";
import { setupDomainDnsRecord } from "@/lib/domains/dns-setup";
import { adoptCloudflareZone } from "@/lib/domains/adopt-zone";
import { isManualZone } from "@/lib/domains/provision";
import { listDomainMx, MxConflictError } from "@/lib/domains/receiving-dns";
import { removeResendReceiving, setupResendReceiving, hasResendReceivingConfig } from "@/lib/domains/resend-receiving";
import { hasSesReceivingConfig, removeSesReceiving, setupSesReceiving } from "@/lib/aws/ses-receiving";
import { ensureMailboxDomainRouting } from "@/lib/mailboxes/domain-addresses";
import { assertMxChangeAllowed, republishMtaStsAfterMxChange } from "@/lib/deliverability/mta-sts-guard";
import type { CfDnsRecord } from "@/lib/cloudflare-api.types";
import type { DomainRow } from "@/lib/domains/types";

export type ReceivingProviderId = "none" | "cloudflare" | "resend" | "ses";
export type ConfigurableReceiving = Exclude<ReceivingProviderId, "none">;

const isCloudflareMx = (content: string) => content.toLowerCase().replace(/\.$/, "").endsWith(".mx.cloudflare.net");

/** Email Routing on the zone, the MX and the Worker routes for this domain's mailboxes. */
export async function setupCloudflareReceiving(env: CloudflareEnv, skippedDomain: DomainRow, options: { replaceMx: boolean }): Promise<void> {
	const domain = await adoptCloudflareZone(env, skippedDomain);
	if (isManualZone(domain.zoneId)) throw new Error("Cloudflare Email Routing needs a domain on a Cloudflare zone");
	const mxBefore = await listDomainMx(env, domain);
	const foreign = mxBefore.filter((record) => !isCloudflareMx(record.content ?? ""));
	if (foreign.length > 0 && !options.replaceMx) {
		throw new MxConflictError(foreign.map((record) => ({ content: record.content ?? "", priority: record.priority ?? 0 })));
	}
	const deletedMx: CfDnsRecord[] = [];
	const knownMxIds = new Set(mxBefore.map((record) => record.id));
	try {
		// Like provisioning, remove the other service's MX before enabling routing; they
		// are put back below if the rest of the setup fails.
		if (foreign.length > 0) await removeMxRecords(env, domain.zoneId, domain.hostname, deletedMx);
		await setupDomainDnsRecord(env, domain, "mx");
	} catch (error) {
		if (deletedMx.length === 0) throw error;
		// Enabling routing can fail after Cloudflare created its MX; drop those so the old records are not left beside them.
		await removeCloudflareMxCreatedSince(env, domain, knownMxIds).catch((cleanupError) => console.warn("Removing partial Cloudflare MX failed", cleanupError));
		return restoreMxRecordsAfterFailure(env, domain.zoneId, deletedMx, error);
	}

	// Cleaning up Cloudflare receiving deletes the per-address Worker routes; put them back.
	const db = getDb(env);
	const mailboxRows = await db
		.select({ id: mailboxes.id, domainId: mailboxes.domainId, localPart: mailboxes.localPart, useAllDomains: mailboxes.useAllDomains })
		.from(mailboxes)
		.innerJoin(domains, eq(mailboxes.domainId, domains.id))
		.where(and(eq(domains.userId, domain.userId), or(eq(mailboxes.domainId, domain.id), eq(mailboxes.useAllDomains, true))));
	const ruleCache: EmailRoutingRuleCache = new Map();
	await Promise.allSettled(mailboxRows.map((mailbox) => ensureMailboxDomainRouting(env, db, { ...mailbox, useAllDomains: true }, undefined, ruleCache)));
}

export async function removeCloudflareReceiving(env: CloudflareEnv, domain: DomainRow): Promise<void> {
	if (isManualZone(domain.zoneId)) return;
	await deleteEmailRoutingRulesForDomain(env, domain.zoneId, domain.hostname);
	await removeCloudflareMx(env, domain);
	const db = getDb(env);
	const [otherDomainOnZone] = await db.select({ id: domains.id }).from(domains).where(and(eq(domains.zoneId, domain.zoneId), ne(domains.id, domain.id))).limit(1);
	if (domain.routingEnabled && !otherDomainOnZone) await disableEmailRouting(env, domain.zoneId);
	await db.update(domains).set({ routingEnabled: false }).where(eq(domains.id, domain.id));
}

async function removeCloudflareMxCreatedSince(env: CloudflareEnv, domain: DomainRow, knownIds: Set<string | undefined>): Promise<void> {
	for (const record of await listDomainMx(env, domain)) {
		if (record.id && !knownIds.has(record.id) && isCloudflareMx(record.content ?? "")) await deleteDnsRecord(env, domain.zoneId, record.id);
	}
}

async function removeCloudflareMx(env: CloudflareEnv, domain: DomainRow): Promise<void> {
	for (const record of await listDomainMx(env, domain)) {
		if (record.id && isCloudflareMx(record.content ?? "")) await deleteDnsRecord(env, domain.zoneId, record.id);
	}
}

export async function setupReceiving(
	env: CloudflareEnv,
	domain: DomainRow,
	provider: ConfigurableReceiving,
	origin: string,
	options: { replaceMx: boolean },
): Promise<void> {
	// Enforce refuses before anything is touched; a testing policy is republished with the new MX list afterwards.
	await assertMxChangeAllowed(env, domain);
	if (provider === "cloudflare") await setupCloudflareReceiving(env, domain, options);
	else if (provider === "resend") await setupResendReceiving(env, domain, origin, options);
	else await setupSesReceiving(env, domain, origin, options);
	await republishMtaStsAfterMxChange(env, domain);
	if (provider === "cloudflare") return;
	// Same as a domain created with DNS: once receiving works, inbound routing
	// (which only resolves active domains) must see this domain.
	await getDb(env).update(domains).set({ status: "active" }).where(eq(domains.id, domain.id));
}

export async function removeReceiving(env: CloudflareEnv, domain: DomainRow, provider: ConfigurableReceiving): Promise<void> {
	// Removing a provider's setup deletes its MX records.
	await assertMxChangeAllowed(env, domain);
	if (provider === "cloudflare") await removeCloudflareReceiving(env, domain);
	else if (provider === "resend") await removeResendReceiving(env, domain);
	else await removeSesReceiving(env, domain);
	await republishMtaStsAfterMxChange(env, domain);
}

/** Which providers have leftover receiving configuration (null = could not tell). */
export async function receivingPresence(env: CloudflareEnv, domain: DomainRow): Promise<Record<ConfigurableReceiving, boolean | null>> {
	const [resend, ses] = await Promise.all([hasResendReceivingConfig(env, domain), hasSesReceivingConfig(env, domain)]);
	return { cloudflare: domain.routingEnabled, resend, ses };
}

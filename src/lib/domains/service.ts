import { eq, and } from "drizzle-orm";
import { getDb } from "@/db";
import { domains } from "@/db/schema";
import { newId } from "@/lib/ids";
import {
	disableEmailRouting,
	getEmailRoutingDns,
	getEmailRoutingSettings,
	getSendingSubdomainDns,
	deleteSendingSubdomain,
	type CfDnsRecord,
} from "@/lib/cloudflare-api";
import { provisionDomainOnCloudflare } from "@/lib/domains/provision";

export type DomainDnsView = {
	routing: { records: CfDnsRecord[]; missing: CfDnsRecord[]; status?: string };
	sending: CfDnsRecord[];
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
): Promise<{ domain: typeof domains.$inferSelect; dns: DomainDnsView }> {
	const provisioned = await provisionDomainOnCloudflare(env, hostname, options);

	const db = getDb(env);
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
	}

	const [domain] = await db.select().from(domains).where(eq(domains.id, domainId)).limit(1);
	const dns = await getDomainDns(env, domain!);
	return { domain: domain!, dns };
}

export async function getDomainDns(
	env: CloudflareEnv,
	domain: typeof domains.$inferSelect,
): Promise<DomainDnsView> {
	const routingDns = await getEmailRoutingDns(env, domain.zoneId);
	const routingSettings = await getEmailRoutingSettings(env, domain.zoneId);
	let sending: CfDnsRecord[] = [];
	if (domain.sendingSubdomainTag) {
		sending = await getSendingSubdomainDns(env, domain.zoneId, domain.sendingSubdomainTag);
	}
	return {
		routing: {
			records: routingDns.records,
			missing: routingDns.missing,
			status: routingSettings.status,
		},
		sending,
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

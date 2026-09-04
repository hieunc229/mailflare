import type { domains } from "@/db/schema";
import type { CfEmailRoutingRule } from "@/lib/cloudflare-api.types";

/**
 * Exactly what one provisioning attempt changed on the Cloudflare zone, so a
 * failure further along can undo its own work and nothing else. Provisioning is
 * idempotent — it happily reuses Email Routing or a sending subdomain the zone
 * already had — and tearing those down would leave the account worse off than
 * the orphaned config the rollback exists to prevent.
 */
export type DomainProvisioningChanges = {
	zoneId: string;
	/** Email Routing was off before this attempt and this attempt turned it on. */
	enabledEmailRouting: boolean;
	/** Tag of a sending subdomain this attempt created; null when one already existed. */
	createdSendingSubdomainTag: string | null;
	/** The zone's catch-all rule as it stood before this attempt overwrote it. */
	previousCatchAll: CfEmailRoutingRule | null;
	/** Addresses this attempt pointed at the Worker, filled in as they are created. */
	createdAddressRules: string[];
};

export type DomainProvisioningResult = {
	hostname: string;
	zone: { id: string; name: string };
	routingEnabled: boolean;
	sendingEnabled: boolean;
	sendingSubdomainTag: string | null;
	routingStatus?: string;
	changes: DomainProvisioningChanges;
};

export type DomainRow = typeof domains.$inferSelect;

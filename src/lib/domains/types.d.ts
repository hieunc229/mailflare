import type { domains } from "@/db/schema";

export type DomainProvisioningResult = {
	hostname: string;
	zone: { id: string; name: string };
	routingEnabled: boolean;
	sendingEnabled: boolean;
	sendingSubdomainTag: string | null;
	routingStatus?: string;
};

export type DomainRow = typeof domains.$inferSelect;

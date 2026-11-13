import { findZoneByHostname } from "@/lib/cloudflare-api";
import { MANUAL_ZONE_ID } from "@/lib/domains/provision";
import type { DomainPreflightResult } from "@/lib/domains/types";
import { hasCloudflareCredentials } from "@/lib/runtime";

export async function preflightDomain(
	env: CloudflareEnv,
	hostname: string,
): Promise<DomainPreflightResult> {
	const normalized = hostname.toLowerCase().trim();
	const zone = await findZoneByHostname(env, normalized);
	if (!zone) {
		throw new Error(
			`Zone not found for "${normalized}". The domain must use Cloudflare DNS on this account.`,
		);
	}

	return { hostname: normalized, zone };
}

/** A domain this install will not manage on Cloudflare. Same zone id provisionDomainOnCloudflare records. */
export function manualDomainPreflight(hostname: string): DomainPreflightResult {
	const normalized = hostname.toLowerCase().trim();
	return { hostname: normalized, zone: { id: MANUAL_ZONE_ID, name: normalized } };
}

/**
 * First-run domain check. Skipping DNS, or running without Cloudflare
 * credentials, must not call the zone API: the domain is manually managed
 * and the operator sets records by hand.
 */
export async function preflightSetupDomain(
	env: CloudflareEnv,
	hostname: string,
	options?: { skipDns?: boolean },
): Promise<DomainPreflightResult> {
	if (options?.skipDns || !hasCloudflareCredentials(env)) return manualDomainPreflight(hostname);
	return preflightDomain(env, hostname);
}

import {
	createSendingSubdomain,
	enableEmailRouting,
	findZoneByHostname,
	getEmailRoutingSettings,
	listSendingSubdomains,
} from "@/lib/cloudflare-api";
import {
	ensureEmailRoutingCatchAllToWorker,
	getEmailRoutingCatchAll,
} from "@/lib/domains/catch-all-routing";
import { isZoneApex } from "@/lib/domains/utils";
import { hasCloudflareCredentials } from "@/lib/runtime";
import type { DomainProvisioningChanges, DomainProvisioningResult } from "@/lib/domains/types";

/**
 * Zone id recorded for domains the app does not manage on Cloudflare (a
 * self-hosted install without API credentials). Every Cloudflare call that
 * receives it is a no-op, and the DNS page shows records to set by hand.
 */
export const MANUAL_ZONE_ID = "manual";

export function isManualZone(zoneId: string | null | undefined): boolean {
	return zoneId === MANUAL_ZONE_ID;
}

export async function provisionDomainOnCloudflare(
	env: CloudflareEnv,
	hostname: string,
	options?: { enableRouting?: boolean; enableSending?: boolean },
): Promise<DomainProvisioningResult> {
	const normalized = hostname.toLowerCase().trim();
	if (!hasCloudflareCredentials(env)) {
		// Nothing to provision: the operator points MX at this server themselves.
		return {
			hostname: normalized,
			zone: { id: MANUAL_ZONE_ID, name: normalized },
			// Mail arrives whenever MX points at this server, so the domain is live at once.
			routingEnabled: options?.enableRouting ?? true,
			sendingRequested: options?.enableSending ?? true,
			sendingEnabled: false,
			sendingSubdomainTag: null,
			routingStatus: "manual",
			changes: { zoneId: MANUAL_ZONE_ID, enabledEmailRouting: false, createdSendingSubdomainTag: null, previousCatchAll: null, createdAddressRules: [] },
		};
	}
	const zone = await findZoneByHostname(env, normalized);
	if (!zone) {
		throw new Error(
			`Zone not found for "${normalized}". The domain must use Cloudflare DNS on this account.`,
		);
	}

	const enableRouting = options?.enableRouting ?? true;
	const enableSending = options?.enableSending ?? true;

	let routingEnabled = false;
	let sendingEnabled = false;
	let sendingSubdomainTag: string | null = null;
	let routingStatus: string | undefined;
	const changes: DomainProvisioningChanges = {
		zoneId: zone.id,
		enabledEmailRouting: false,
		createdSendingSubdomainTag: null,
		previousCatchAll: null,
		createdAddressRules: [],
	};

	if (enableRouting) {
		// Record the zone's prior state before changing it: rolling back must only
		// undo what this call did, never Email Routing the account already had.
		// If the state cannot be read, assume it was already on — leaving an orphan
		// behind is far cheaper than disabling a zone someone else's mail depends on.
		let routingWasEnabled = true;
		try {
			const settings = await getEmailRoutingSettings(env, zone.id);
			routingWasEnabled = settings.enabled === true;
		} catch {
			// Keep the fail-safe default.
		}
		// The catch-all is a singleton and the PUT below overwrites it, so keep a copy.
		changes.previousCatchAll = routingWasEnabled ? await getEmailRoutingCatchAll(env, zone.id) : null;

		const routingName = isZoneApex(normalized, zone.name) ? undefined : normalized;
		const routing = await enableEmailRouting(env, zone.id, routingName);
		changes.enabledEmailRouting = !routingWasEnabled;
		routingEnabled = routing.enabled ?? true;
		routingStatus = routing.status;
		await ensureEmailRoutingCatchAllToWorker(env, zone.id);
	}

	if (enableSending) {
		const subs = await listSendingSubdomains(env, zone.id);
		const existingSub = subs.find((s) => s.name === normalized);
		if (existingSub) {
			sendingSubdomainTag = existingSub.tag;
			sendingEnabled = existingSub.enabled;
		} else {
			const created = await createSendingSubdomain(env, zone.id, normalized);
			sendingSubdomainTag = created.tag;
			sendingEnabled = created.enabled;
			changes.createdSendingSubdomainTag = created.tag;
		}
	}

	return {
		hostname: normalized,
		zone,
		routingEnabled,
		sendingRequested: enableSending,
		sendingEnabled,
		sendingSubdomainTag,
		routingStatus,
		changes,
	};
}

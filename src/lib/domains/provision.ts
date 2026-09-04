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
import type { DomainProvisioningChanges, DomainProvisioningResult } from "@/lib/domains/types";

export async function provisionDomainOnCloudflare(
	env: CloudflareEnv,
	hostname: string,
	options?: { enableRouting?: boolean; enableSending?: boolean },
): Promise<DomainProvisioningResult> {
	const normalized = hostname.toLowerCase().trim();
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
		if (isZoneApex(normalized, zone.name)) {
			sendingEnabled = false;
		} else {
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
	}

	return {
		hostname: normalized,
		zone,
		routingEnabled,
		sendingEnabled,
		sendingSubdomainTag,
		routingStatus,
		changes,
	};
}

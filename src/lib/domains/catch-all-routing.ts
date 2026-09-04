import { cfRequest } from "@/lib/cloudflare-api";
import type { CfEmailRoutingRule } from "@/lib/cloudflare-api.types";
import { getEmailWorkerName } from "@/lib/cloudflare-api-utils";

export async function getEmailRoutingCatchAll(
	env: CloudflareEnv,
	zoneId: string,
): Promise<CfEmailRoutingRule | null> {
	try {
		return await cfRequest<CfEmailRoutingRule>(
			env,
			`/zones/${zoneId}/email/routing/rules/catch_all`,
		);
	} catch {
		// A zone without Email Routing has no catch-all to read; treat it as absent.
		return null;
	}
}

export async function ensureEmailRoutingCatchAllToWorker(
	env: CloudflareEnv,
	zoneId: string,
): Promise<CfEmailRoutingRule> {
	const workerName = getEmailWorkerName();
	return cfRequest<CfEmailRoutingRule>(
		env,
		`/zones/${zoneId}/email/routing/rules/catch_all`,
		{
			method: "PUT",
			body: JSON.stringify({
				actions: [{ type: "worker", value: [workerName] }],
				enabled: true,
				matchers: [{ type: "all" }],
				name: `Route all email to ${workerName}`,
			}),
		},
	);
}

/**
 * Put back a catch-all captured before `ensureEmailRoutingCatchAllToWorker`
 * overwrote it. The catch-all is a singleton per zone, so it cannot be deleted —
 * restoring means writing the previous rule back, or falling back to
 * Cloudflare's own default (a disabled drop) when the zone never had one.
 */
export async function restoreEmailRoutingCatchAll(
	env: CloudflareEnv,
	zoneId: string,
	previous: CfEmailRoutingRule | null,
): Promise<void> {
	const actions = previous?.actions?.length ? previous.actions : [{ type: "drop" as const }];
	const matchers = previous?.matchers?.length ? previous.matchers : [{ type: "all" as const }];
	await cfRequest<CfEmailRoutingRule>(
		env,
		`/zones/${zoneId}/email/routing/rules/catch_all`,
		{
			method: "PUT",
			body: JSON.stringify({
				actions,
				enabled: previous?.enabled ?? false,
				matchers,
				...(previous?.name ? { name: previous.name } : {}),
			}),
		},
	);
}

import type {
	CfDnsRecord,
	CfEmailRoutingRule,
	CfEmailRoutingRuleChange,
	CfResponse,
	CfResultInfo,
	CfSendingSubdomain,
} from "@/lib/cloudflare-api.types";
import {
	formatCloudflareError,
	getCloudflareAuth,
	getCloudflareAuthHeaders,
	getCloudflareAuthHint,
	getEmailWorkerName,
} from "@/lib/cloudflare-api-utils";
import { CloudflareApiError } from "@/lib/cloudflare-api-error";
import { getZoneLookupCandidates } from "@/lib/domains/utils";
export type { CfDnsRecord } from "@/lib/cloudflare-api.types";

const CF_REQUEST_TIMEOUT_MS = 30_000;

async function cfRequestWithInfo<T>(
	env: CloudflareEnv,
	path: string,
	init?: RequestInit,
): Promise<{ result: T; resultInfo?: CfResultInfo }> {
	const auth = getCloudflareAuth(env);
	const res = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
		signal: AbortSignal.timeout(CF_REQUEST_TIMEOUT_MS),
		...init,
		headers: {
			...getCloudflareAuthHeaders(auth),
			"Content-Type": "application/json",
			...(init?.headers ?? {}),
		},
	});
	// Cloudflare answers incidents with an HTML page; report it as an API error, not a parse error.
	const json = (await res.json().catch(() => null)) as CfResponse<T> | null;
	if (!json) {
		throw new CloudflareApiError(
			`Cloudflare API ${path} returned ${res.status} ${res.statusText} without a JSON body`.trim(),
			res.status,
			path,
			[],
		);
	}

	if (!json.success) {
		throw new CloudflareApiError(
			`${formatCloudflareError(path, res.status, res.statusText, json.errors ?? [])}${getCloudflareAuthHint(json.errors ?? [], path)}`,
			res.status,
			path,
			json.errors ?? [],
		);
	}
	return { result: json.result, resultInfo: json.result_info };
}

export async function cfRequest<T>(
	env: CloudflareEnv,
	path: string,
	init?: RequestInit,
): Promise<T> {
	return (await cfRequestWithInfo<T>(env, path, init)).result;
}

export async function getZone(
	env: CloudflareEnv,
	zoneId: string,
): Promise<{ id: string; name: string }> {
	return cfRequest<{ id: string; name: string }>(env, `/zones/${zoneId}`);
}

export async function findZoneByHostname(
	env: CloudflareEnv,
	hostname: string,
): Promise<{ id: string; name: string } | null> {
	for (const candidate of getZoneLookupCandidates(hostname)) {
		const zones = await cfRequest<{ id: string; name: string }[]>(
			env,
			`/zones?name=${encodeURIComponent(candidate)}&status=active`,
		);
		const zone = zones.find((z) => z.name === candidate);
		if (zone) return zone;
	}

	return null;
}

export async function getEmailRoutingDns(
	env: CloudflareEnv,
	zoneId: string,
): Promise<{ records: CfDnsRecord[]; missing: CfDnsRecord[] }> {
	const result = await cfRequest<{
		record?: CfDnsRecord[];
		errors?: { missing?: CfDnsRecord }[];
	}>(env, `/zones/${zoneId}/email/routing/dns`);
	return {
		records: result.record ?? [],
		missing: (result.errors ?? [])
			.map((e) => e.missing)
			.filter(Boolean) as CfDnsRecord[],
	};
}

export async function enableEmailRouting(
	env: CloudflareEnv,
	zoneId: string,
	hostname?: string,
) {
	return cfRequest<{ status?: string; enabled?: boolean }>(
		env,
		`/zones/${zoneId}/email/routing/dns`,
		{
			method: "POST",
			...(hostname ? { body: JSON.stringify({ name: hostname }) } : {}),
		},
	);
}

export async function disableEmailRouting(env: CloudflareEnv, zoneId: string) {
	return cfRequest<unknown>(env, `/zones/${zoneId}/email/routing/dns`, {
		method: "DELETE",
	});
}

export async function listSendingSubdomains(
	env: CloudflareEnv,
	zoneId: string,
) {
	return cfRequest<CfSendingSubdomain[]>(
		env,
		`/zones/${zoneId}/email/sending/subdomains`,
	);
}

export async function createSendingSubdomain(
	env: CloudflareEnv,
	zoneId: string,
	hostname: string,
) {
	return cfRequest<{ tag: string; name: string; enabled: boolean }>(
		env,
		`/zones/${zoneId}/email/sending/subdomains`,
		{
			method: "POST",
			body: JSON.stringify({ name: hostname }),
		},
	);
}

export async function deleteSendingSubdomain(
	env: CloudflareEnv,
	zoneId: string,
	subdomainTag: string,
) {
	return cfRequest<unknown>(
		env,
		`/zones/${zoneId}/email/sending/subdomains/${subdomainTag}`,
		{ method: "DELETE" },
	);
}

export async function getSendingSubdomainDns(
	env: CloudflareEnv,
	zoneId: string,
	subdomainTag: string,
): Promise<CfDnsRecord[]> {
	return cfRequest<CfDnsRecord[]>(
		env,
		`/zones/${zoneId}/email/sending/subdomains/${subdomainTag}/dns`,
	);
}

export async function getEmailRoutingSettings(
	env: CloudflareEnv,
	zoneId: string,
) {
	return cfRequest<{ enabled?: boolean; status?: string; name?: string }>(
		env,
		`/zones/${zoneId}/email/routing`,
	);
}

const RULES_PER_PAGE = 50;
const MAX_RULE_PAGES = 100;

/**
 * Every routing rule in the zone; the API returns them one page at a time.
 * Throws when the page cap is hit: callers decide whether a rule exists from
 * this list, and a partial list would make them create duplicates.
 */
export async function listEmailRoutingRules(env: CloudflareEnv, zoneId: string) {
	const rules: CfEmailRoutingRule[] = [];
	for (let page = 1; page <= MAX_RULE_PAGES; page += 1) {
		const { result, resultInfo } = await cfRequestWithInfo<CfEmailRoutingRule[]>(
			env,
			`/zones/${zoneId}/email/routing/rules?page=${page}&per_page=${RULES_PER_PAGE}`,
		);
		rules.push(...result);
		const lastPage = resultInfo?.total_pages !== undefined ? page >= resultInfo.total_pages : result.length < RULES_PER_PAGE;
		if (lastPage || result.length === 0) return rules;
	}
	throw new Error(`Email routing rules for zone ${zoneId} span more than ${MAX_RULE_PAGES} pages`);
}

export async function deleteEmailRoutingRule(
	env: CloudflareEnv,
	zoneId: string,
	ruleId: string,
) {
	return cfRequest<unknown>(
		env,
		`/zones/${zoneId}/email/routing/rules/${ruleId}`,
		{ method: "DELETE" },
	);
}

export async function createEmailRoutingRuleToWorker(
	env: CloudflareEnv,
	zoneId: string,
	address: string,
) {
	const workerName = getEmailWorkerName();
	return cfRequest<CfEmailRoutingRule>(
		env,
		`/zones/${zoneId}/email/routing/rules`,
		{
			method: "POST",
			body: JSON.stringify({
				actions: [{ type: "worker", value: [workerName] }],
				enabled: true,
				matchers: [{ type: "literal", field: "to", value: address }],
				name: `Route ${address} to ${workerName}`,
			}),
		},
	);
}

function isWorkerRouteForAddress(
	rule: CfEmailRoutingRule,
	normalizedAddress: string,
	workerName: string,
): boolean {
	const routesAddress = rule.matchers?.some(
		(matcher) => matcher.type === "literal" && matcher.field === "to" && matcher.value?.toLowerCase() === normalizedAddress,
	);
	const sendsToWorker = rule.actions?.some(
		(action) => action.type === "worker" && (action.value?.length ? action.value.includes(workerName) : true),
	);
	return Boolean(routesAddress && sendsToWorker);
}

/** One rules listing per zone, shared by the calls of a single operation. */
export type EmailRoutingRuleCache = Map<string, Promise<CfEmailRoutingRule[]>>;

function listEmailRoutingRulesCached(env: CloudflareEnv, zoneId: string, cache?: EmailRoutingRuleCache) {
	if (!cache) return listEmailRoutingRules(env, zoneId);
	let listing = cache.get(zoneId);
	if (!listing) {
		listing = listEmailRoutingRules(env, zoneId);
		cache.set(zoneId, listing);
		// A failed listing must not stay cached for the next address.
		listing.catch(() => cache.delete(zoneId));
	}
	return listing;
}

export async function ensureEmailRoutingRuleToWorker(
	env: CloudflareEnv,
	zoneId: string,
	address: string,
	changes?: CfEmailRoutingRuleChange[],
	ruleCache?: EmailRoutingRuleCache,
) {
	if (zoneId === "manual") return;
	const normalized = address.toLowerCase();
	const workerName = getEmailWorkerName();
	const rules = await listEmailRoutingRulesCached(env, zoneId, ruleCache);
	const existing = rules.find((rule) => isWorkerRouteForAddress(rule, normalized, workerName));

	if (existing?.enabled) return existing;
	if (existing?.id) {
		changes?.push({ zoneId, ruleId: existing.id, previous: existing });
		return cfRequest<CfEmailRoutingRule>(
			env,
			`/zones/${zoneId}/email/routing/rules/${existing.id}`,
			{
				method: "PUT",
				body: JSON.stringify({
					actions: [{ type: "worker", value: [workerName] }],
					enabled: true,
					matchers: [{ type: "literal", field: "to", value: normalized }],
					name: existing.name ?? `Route ${normalized} to ${workerName}`,
					priority: existing.priority,
				}),
			},
		);
	}

	const created = await createEmailRoutingRuleToWorker(env, zoneId, normalized);
	if (created.id) changes?.push({ zoneId, ruleId: created.id });
	return created;
}

/** Undo only the rules created or re-enabled by a failed provisioning attempt. */
export async function rollbackEmailRoutingRuleChanges(env: CloudflareEnv, changes: CfEmailRoutingRuleChange[]) {
	const results = await Promise.allSettled(changes.map(({ zoneId, ruleId, previous }) =>
		previous
			? cfRequest(env, `/zones/${zoneId}/email/routing/rules/${ruleId}`, {
				method: "PUT",
				body: JSON.stringify({
					actions: previous.actions, enabled: previous.enabled, matchers: previous.matchers,
					name: previous.name, priority: previous.priority,
				}),
			})
			: deleteEmailRoutingRule(env, zoneId, ruleId),
	));
	const failures = results.filter((result) => result.status === "rejected");
	if (failures.length) throw new AggregateError(failures.map((result) => result.reason), "Unable to restore routing rules");
}

export async function deleteEmailRoutingRuleForAddress(
	env: CloudflareEnv,
	zoneId: string,
	address: string,
): Promise<boolean> {
	if (zoneId === "manual") return false;
	const normalized = address.toLowerCase();
	const workerName = getEmailWorkerName();
	const rules = await listEmailRoutingRules(env, zoneId);
	const existing = rules.find((rule) => isWorkerRouteForAddress(rule, normalized, workerName));
	if (!existing?.id) return false;
	await deleteEmailRoutingRule(env, zoneId, existing.id);
	return true;
}

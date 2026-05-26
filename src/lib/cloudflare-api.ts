import type { CfDnsRecord, CfEmailRoutingRule, CfResponse } from "@/lib/cloudflare-api.types";
import {
	formatCloudflareError,
	getCloudflareAuth,
	getCloudflareAuthHeaders,
	getCloudflareAuthHint,
	getEmailWorkerName,
} from "@/lib/cloudflare-api-utils";
import { getZoneLookupCandidates } from "@/lib/domains/utils";
export type { CfDnsRecord } from "@/lib/cloudflare-api.types";

async function cfRequest<T>(
	env: CloudflareEnv,
	path: string,
	init?: RequestInit,
): Promise<T> {
	const auth = getCloudflareAuth(env);
	const res = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
		...init,
		headers: {
			...getCloudflareAuthHeaders(auth),
			"Content-Type": "application/json",
			...(init?.headers ?? {}),
		},
	});
	const json = (await res.json()) as CfResponse<T>;

	if (!json.success) {
		throw new Error(
			`${formatCloudflareError(path, res.status, res.statusText, json.errors ?? [])}${getCloudflareAuthHint(json.errors ?? [])}`,
		);
	}
	return json.result;
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
	return cfRequest<{ tag: string; name: string; enabled: boolean }[]>(
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

export async function listEmailRoutingRules(env: CloudflareEnv, zoneId: string) {
	return cfRequest<CfEmailRoutingRule[]>(
		env,
		`/zones/${zoneId}/email/routing/rules`,
	);
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
	const workerName = getEmailWorkerName(env);
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

export async function ensureEmailRoutingRuleToWorker(
	env: CloudflareEnv,
	zoneId: string,
	address: string,
) {
	const normalized = address.toLowerCase();
	const workerName = getEmailWorkerName(env);
	const rules = await listEmailRoutingRules(env, zoneId);
	const existing = rules.find((rule) => {
		const routesAddress = rule.matchers?.some(
			(matcher) => matcher.type === "literal" && matcher.field === "to" && matcher.value?.toLowerCase() === normalized,
		);
		const sendsToWorker = rule.actions?.some(
			(action) => action.type === "worker" && (action.value?.length ? action.value.includes(workerName) : true),
		);
		return rule.enabled && routesAddress && sendsToWorker;
	});

	if (existing) return existing;

	return createEmailRoutingRuleToWorker(env, zoneId, normalized);
}

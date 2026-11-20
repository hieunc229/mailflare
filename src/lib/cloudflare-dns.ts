import { cfRequest } from "@/lib/cloudflare-api";
import type { CfDnsRecord } from "@/lib/cloudflare-api.types";
import type { CloudflareDnsRecordCreate } from "@/lib/cloudflare-dns.types";

export async function listMxRecords(
	env: CloudflareEnv,
	zoneId: string,
	hostname: string,
): Promise<CfDnsRecord[]> {
	return cfRequest<CfDnsRecord[]>(
		env,
		`/zones/${zoneId}/dns_records?type=MX&name=${encodeURIComponent(hostname)}&per_page=5000`,
	);
}

export async function listDnsRecords(
	env: CloudflareEnv,
	zoneId: string,
	params: { type: string; name: string },
): Promise<CfDnsRecord[]> {
	return cfRequest<CfDnsRecord[]>(
		env,
		`/zones/${zoneId}/dns_records?type=${encodeURIComponent(params.type)}&name=${encodeURIComponent(params.name)}&per_page=5000`,
	);
}

export async function deleteDnsRecord(
	env: CloudflareEnv,
	zoneId: string,
	recordId: string,
): Promise<void> {
	await cfRequest<unknown>(env, `/zones/${zoneId}/dns_records/${recordId}`, {
		method: "DELETE",
	});
}

export async function createDnsRecord(
	env: CloudflareEnv,
	zoneId: string,
	record: CloudflareDnsRecordCreate,
): Promise<CfDnsRecord> {
	return cfRequest<CfDnsRecord>(env, `/zones/${zoneId}/dns_records`, {
		method: "POST",
		body: JSON.stringify(record),
	});
}

/** Changes the content (and optionally the TTL) of a record in place; nothing else about it can be sent. */
export async function updateDnsRecord(
	env: CloudflareEnv,
	zoneId: string,
	recordId: string,
	changes: { content: string; ttl?: number },
): Promise<CfDnsRecord> {
	const body: { content: string; ttl?: number } = { content: changes.content };
	if (changes.ttl !== undefined) body.ttl = changes.ttl;
	return cfRequest<CfDnsRecord>(env, `/zones/${zoneId}/dns_records/${recordId}`, {
		method: "PATCH",
		body: JSON.stringify(body),
	});
}

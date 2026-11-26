import { createDnsRecord, deleteDnsRecord, listMxRecords } from "@/lib/cloudflare-dns";
import type { CfDnsRecord } from "@/lib/cloudflare-api.types";
import type { CloudflareDnsRecordCreate } from "@/lib/cloudflare-dns.types";

function isCloudflareEmailRoutingMx(record: CfDnsRecord): boolean {
	return record.content?.toLowerCase().endsWith(".mx.cloudflare.net") ?? false;
}

function toCreateInput(record: CfDnsRecord): CloudflareDnsRecordCreate {
	if (!record.name || !record.content || record.priority === undefined) {
		throw new Error("Cloudflare returned an incomplete MX record");
	}

	return {
		type: "MX",
		name: record.name,
		content: record.content,
		priority: record.priority,
		ttl: record.ttl ?? 1,
		...(record.proxied === undefined ? {} : { proxied: record.proxied }),
		...(record.comment === undefined ? {} : { comment: record.comment }),
		...(record.tags === undefined ? {} : { tags: record.tags }),
	};
}

export async function removeMxRecords(
	env: CloudflareEnv,
	zoneId: string,
	hostname: string,
	deleted: CfDnsRecord[],
): Promise<void> {
	const records = (await listMxRecords(env, zoneId, hostname)).filter(
		(record) => !isCloudflareEmailRoutingMx(record),
	);

	for (const record of records) {
		if (!record.id) throw new Error("Cloudflare returned an MX record without an id");
		await deleteDnsRecord(env, zoneId, record.id);
		deleted.push(record);
	}
}

/** MX records on `hostname` that point somewhere other than Cloudflare Email Routing. */
export async function listConflictingMxRecords(
	env: CloudflareEnv,
	zoneId: string,
	hostname: string,
): Promise<CfDnsRecord[]> {
	const records = await listMxRecords(env, zoneId, hostname);
	return records.filter((record) => !isCloudflareEmailRoutingMx(record));
}

export async function hasConflictingMxRecords(
	env: CloudflareEnv,
	zoneId: string,
	hostname: string,
): Promise<boolean> {
	const records = await listMxRecords(env, zoneId, hostname);
	return records.some((record) => !isCloudflareEmailRoutingMx(record));
}

/** Re-creates every record it can, then reports the ones it could not. */
export async function restoreMxRecords(
	env: CloudflareEnv,
	zoneId: string,
	records: CfDnsRecord[],
): Promise<void> {
	const failed: CfDnsRecord[] = [];
	const reasons: unknown[] = [];
	for (const record of records) {
		try {
			await createDnsRecord(env, zoneId, toCreateInput(record));
		} catch (error) {
			failed.push(record);
			reasons.push(error);
		}
	}
	if (failed.length > 0) throw new MxRestoreError(failed, reasons);
}

/** The MX records a failed change deleted could not be put back; the domain may have no MX. */
export class MxRestoreError extends AggregateError {
	constructor(readonly records: CfDnsRecord[], reasons: unknown[], failure?: string) {
		super(
			reasons,
			`${failure ? `${failure}. ` : ""}The previous MX records (${records.map((record) => `${record.priority ?? "?"} ${record.content ?? "?"}`).join(", ")}) could not be restored. Add them back at your DNS provider.`,
		);
		this.name = "MxRestoreError";
	}
}

/**
 * Cleanup for a change that deleted MX records and then failed: put them back and
 * rethrow the original error. When they cannot be restored the failure is raised
 * instead (with the original error as `cause`), so it is never only a log line.
 */
export async function restoreMxRecordsAfterFailure(
	env: CloudflareEnv,
	zoneId: string,
	deleted: CfDnsRecord[],
	original: unknown,
): Promise<never> {
	if (deleted.length > 0) {
		try {
			await restoreMxRecords(env, zoneId, deleted);
		} catch (restoreError) {
			const failure = restoreError as MxRestoreError;
			throw new MxRestoreError(failure.records ?? deleted, [...(failure.errors ?? [restoreError]), original], original instanceof Error ? original.message : String(original));
		}
	}
	throw original;
}

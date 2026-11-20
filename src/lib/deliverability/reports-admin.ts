import { and, eq, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { domainDeliverability, mailboxAliases, mailboxes } from "@/db/schema";
import { deleteEmailRoutingRuleForAddress, ensureEmailRoutingRuleToWorker } from "@/lib/cloudflare-api";
import { createDnsRecord, deleteDnsRecord, listDnsRecords, updateDnsRecord } from "@/lib/cloudflare-dns";
import { isCloudflareZoneUnavailable } from "@/lib/cloudflare-api-error";
import { queryDns } from "@/lib/dns-query";
import { withoutRuaUri, withRuaUri } from "./dmarc-record";
import { organisationalDomain } from "./org-domain";
import { REPORT_ADDRESS_LOCAL_PART, reportAddress } from "./report-address";

type Domain = { id: string; hostname: string; zoneId: string; receivingProvider: string };

/** `changed` with `after: null` means the record is deleted. */
export type DmarcPlan = { address: string; before: string | null; after: string | null; changed: boolean; manual: boolean };
export type ReportState = { address: string; enabled: boolean; alertEmail: boolean; enabledAt: string | null; lastReportAt: string | null };
export type ReportsResult =
	| { kind: "preview"; plan: DmarcPlan }
	| { kind: "ok"; state: ReportState; plan?: DmarcPlan }
	| { kind: "error"; status: number; code: string; message: string };

/** The network edges, injectable so the flow is testable without Cloudflare. */
export type ReportsDeps = {
	listTxt(env: CloudflareEnv, zoneId: string, name: string): Promise<{ id?: string; content?: string }[]>;
	queryTxt(name: string): Promise<string[]>;
	createTxt(env: CloudflareEnv, zoneId: string, name: string, content: string): Promise<unknown>;
	updateTxt(env: CloudflareEnv, zoneId: string, id: string, content: string): Promise<unknown>;
	deleteTxt(env: CloudflareEnv, zoneId: string, id: string): Promise<unknown>;
	ensureRoute(env: CloudflareEnv, zoneId: string, address: string): Promise<unknown>;
	deleteRoute(env: CloudflareEnv, zoneId: string, address: string): Promise<unknown>;
};

export const reportsDeps: ReportsDeps = {
	listTxt: (env, zoneId, name) => listDnsRecords(env, zoneId, { type: "TXT", name }),
	queryTxt: (name) => queryDns(name, "TXT"),
	createTxt: (env, zoneId, name, content) => createDnsRecord(env, zoneId, { type: "TXT", name, content, ttl: 3600 }),
	updateTxt: (env, zoneId, id, content) => updateDnsRecord(env, zoneId, id, { content }),
	deleteTxt: (env, zoneId, id) => deleteDnsRecord(env, zoneId, id),
	ensureRoute: (env, zoneId, address) => ensureEmailRoutingRuleToWorker(env, zoneId, address),
	deleteRoute: (env, zoneId, address) => deleteEmailRoutingRuleForAddress(env, zoneId, address),
};

const fail = (status: number, code: string, message: string): ReportsResult => ({ kind: "error", status, code, message });
export const isManual = (domain: Pick<Domain, "zoneId">) => domain.zoneId === "manual";
/** Cloudflare may return TXT content wrapped in quotes (and split in chunks). */
export const unquote = (content: string) => content.replace(/^"([\s\S]*)"$/, "$1").replace(/"\s*"/g, "");
const isDmarc = (content: string) => /^\s*v=DMARC1\s*(?:;|$)/i.test(content);

export class DnsReadError extends Error {
	constructor(message: string, readonly zoneUnavailable = false) {
		super(message);
	}
}
/** Cloudflare says the zone is gone or off limits (404, 403). Turning a feature off then works as in a manual zone: the record is left to the admin. */
export const isZoneUnavailable = (error: unknown) => (error instanceof DnsReadError && error.zoneUnavailable) || isCloudflareZoneUnavailable(error);
export class MultipleRecordsError extends Error {}

/** The single TXT record at `name` that `matches`, read from Cloudflare (or DNS-over-HTTPS for a manual zone). More than one throws. */
export async function readTxtRecord(env: CloudflareEnv, domain: Pick<Domain, "zoneId">, name: string, matches: (content: string) => boolean, deps: ReportsDeps): Promise<{ id: string | null; content: string } | null> {
	let records: { id: string | null; content: string }[];
	try {
		records = isManual(domain)
			? (await deps.queryTxt(name)).map((content) => ({ id: null, content: unquote(content) }))
			: (await deps.listTxt(env, domain.zoneId, name)).map((record) => ({ id: record.id ?? null, content: unquote(record.content ?? "") }));
	} catch (error) {
		throw new DnsReadError(error instanceof Error ? error.message : "DNS lookup failed", isCloudflareZoneUnavailable(error));
	}
	const found = records.filter((record) => matches(record.content));
	if (found.length > 1) throw new MultipleRecordsError();
	return found[0] ?? null;
}

const readDmarc = (env: CloudflareEnv, domain: Domain, deps: ReportsDeps) => readTxtRecord(env, domain, `_dmarc.${domain.hostname}`, isDmarc, deps);

const TAG = (record: string, name: string) => new RegExp(`(?:^|;)\\s*${name}\\s*=\\s*([^;]*?)\\s*(?=;|$)`, "i").exec(record)?.[1];
const POLICIES = ["none", "quarantine", "reject"];

/**
 * The record for a subdomain that has none: it would otherwise inherit its organisation's policy, so the new record
 * must say the same thing (`sp`, else `p`; alignment modes and `pct` kept) or enabling reports would silently
 * weaken or change what receivers do with mail from it. An organisation with no usable single record means `none`.
 */
async function inheritedRecord(domain: Domain, address: string, deps: ReportsDeps): Promise<string> {
	let policy = "none";
	const extras: string[] = [];
	const organisation = organisationalDomain(domain.hostname);
	if (organisation && organisation !== domain.hostname.toLowerCase()) {
		let records: string[];
		try {
			records = await deps.queryTxt(`_dmarc.${organisation}`);
		} catch (error) {
			throw new DnsReadError(error instanceof Error ? error.message : "DNS lookup failed");
		}
		const parents = records.map(unquote).filter(isDmarc);
		if (parents.length === 1) {
			const [parent] = parents;
			policy = [TAG(parent, "sp"), TAG(parent, "p")].map((value) => value?.toLowerCase() ?? "").find((value) => POLICIES.includes(value)) ?? "none";
			for (const name of ["adkim", "aspf"]) {
				const value = TAG(parent, name)?.toLowerCase();
				if (value === "r" || value === "s") extras.push(`${name}=${value}`);
			}
			const pct = TAG(parent, "pct");
			if (pct && /^\d{1,3}$/.test(pct) && Number(pct) <= 100) extras.push(`pct=${Number(pct)}`);
		}
	}
	return ["v=DMARC1", `p=${policy}`, ...extras, `rua=mailto:${address}`].join("; ");
}

/**
 * What turning reporting on or off would do to `_dmarc`. Turning off removes the whole record only when we created
 * it (`createdRecord`) and it still reads exactly as we wrote it; anything else only loses our address from `rua`.
 * A removal is `after: null` with `changed: true`.
 */
export async function planDmarcChange(env: CloudflareEnv, domain: Domain, enable: boolean, deps: ReportsDeps = reportsDeps, createdRecord: string | null = null): Promise<DmarcPlan & { recordId: string | null }> {
	const address = reportAddress(domain.hostname);
	const current = await readDmarc(env, domain, deps);
	const before = current?.content ?? null;
	let after: string | null;
	if (enable) after = current ? withRuaUri(current.content, address) : await inheritedRecord(domain, address, deps);
	else after = current && createdRecord !== null && current.content === createdRecord ? null : current ? withoutRuaUri(current.content, address) : null;
	return { address, before, after, changed: after !== before, manual: isManual(domain), recordId: current?.id ?? null };
}

export async function getReportState(env: CloudflareEnv, domain: Pick<Domain, "id" | "hostname">): Promise<ReportState> {
	const [row] = await getDb(env).select().from(domainDeliverability).where(eq(domainDeliverability.domainId, domain.id)).limit(1);
	return {
		address: reportAddress(domain.hostname),
		enabled: row?.reportsEnabled ?? false,
		alertEmail: row?.alertEmail ?? false,
		enabledAt: row?.reportsEnabledAt?.toISOString() ?? null,
		lastReportAt: row?.lastReportAt?.toISOString() ?? null,
	};
}

async function save(env: CloudflareEnv, domainId: string, values: Partial<typeof domainDeliverability.$inferInsert>) {
	const now = new Date();
	await getDb(env).insert(domainDeliverability).values({ domainId, updatedAt: now, ...values }).onConflictDoUpdate({ target: domainDeliverability.domainId, set: { ...values, updatedAt: now } });
}

async function addressTaken(env: CloudflareEnv, domainId: string): Promise<boolean> {
	const db = getDb(env);
	const [mailbox] = await db.select({ id: mailboxes.id }).from(mailboxes).where(and(eq(mailboxes.domainId, domainId), eq(sql`lower(${mailboxes.localPart})`, REPORT_ADDRESS_LOCAL_PART))).limit(1);
	if (mailbox) return true;
	const [alias] = await db.select({ id: mailboxAliases.id }).from(mailboxAliases).where(and(eq(mailboxAliases.domainId, domainId), eq(sql`lower(${mailboxAliases.localPart})`, REPORT_ADDRESS_LOCAL_PART))).limit(1);
	return Boolean(alias);
}

/**
 * Turns DMARC reporting on or off for a domain. Turning it on or off edits `_dmarc` (adding or removing only our
 * rua address), so it answers with a before/after preview until the caller confirms. Reporting stays off unless
 * every step succeeded; a stored report is kept when it is turned off.
 */
export async function updateReports(env: CloudflareEnv, domain: Domain, body: unknown, deps: ReportsDeps = reportsDeps): Promise<ReportsResult> {
	const input = body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
	const enabled = input?.enabled;
	const alertEmail = input?.alertEmail;
	if (!input || (enabled !== undefined && typeof enabled !== "boolean") || (alertEmail !== undefined && typeof alertEmail !== "boolean") || (enabled === undefined && alertEmail === undefined)) {
		return fail(400, "INVALID_BODY", "Expected { enabled?: boolean, alertEmail?: boolean, confirm?: boolean, previewed?: { before, after } }");
	}
	// Confirming applies exactly the plan the admin was shown, so it names it.
	const previewed = input.previewed && typeof input.previewed === "object" && !Array.isArray(input.previewed) ? (input.previewed as Record<string, unknown>) : null;
	const isRecord = (value: unknown) => value === null || typeof value === "string";
	if (input.confirm === true && typeof enabled === "boolean" && (!previewed || !isRecord(previewed.before) || !isRecord(previewed.after) || !("before" in previewed) || !("after" in previewed))) {
		return fail(400, "INVALID_BODY", "Confirming needs the previewed { before, after } record");
	}

	let plan: (DmarcPlan & { recordId: string | null }) | undefined;
	if (typeof enabled === "boolean") {
		if (enabled) {
			if (domain.receivingProvider === "none") return fail(409, "RECEIVING_REQUIRED", "Turn on receiving for this domain first");
			if (await addressTaken(env, domain.id)) return fail(409, "ADDRESS_TAKEN", `A mailbox or alias already uses ${REPORT_ADDRESS_LOCAL_PART}`);
		}
		const [stored] = await getDb(env).select({ created: domainDeliverability.dmarcCreatedRecord, tlsRpt: domainDeliverability.tlsRptEnabled }).from(domainDeliverability).where(eq(domainDeliverability.domainId, domain.id)).limit(1);
		// TLS reports arrive at this address and use its routing rule, so they must be turned off first.
		if (!enabled && stored?.tlsRpt) return fail(409, "TLS_RPT_ON", "Turn off TLS reports first; they arrive at the same address");
		try {
			plan = await planDmarcChange(env, domain, enabled, deps, stored?.created ?? null);
		} catch (error) {
			if (error instanceof MultipleRecordsError) return fail(409, "MULTIPLE_DMARC_RECORDS", "More than one DMARC record exists; remove the extra ones first");
			if (error instanceof DnsReadError) return fail(502, "DNS_FAILED", "Could not read the current DMARC record");
			throw error;
		}
		const { recordId, ...preview } = plan;
		if (input.confirm !== true) return { kind: "preview", plan: preview };
		if (previewed?.before !== preview.before || previewed?.after !== preview.after) return fail(409, "DMARC_CHANGED", "The DMARC record changed since the preview; review it again");

		const viaCloudflare = !isManual(domain) && domain.receivingProvider === "cloudflare";
		const address = reportAddress(domain.hostname);
		let routed = false;
		if (enabled && viaCloudflare) {
			try {
				await deps.ensureRoute(env, domain.zoneId, address);
				routed = true;
			} catch (error) {
				console.error(`DMARC report routing rule failed for ${domain.hostname}`, error);
				return fail(502, "ROUTING_FAILED", "Could not create the email routing rule");
			}
		}
		if (preview.changed && !preview.manual) {
			try {
				if (preview.after === null) await deps.deleteTxt(env, domain.zoneId, recordId as string);
				else if (recordId) await deps.updateTxt(env, domain.zoneId, recordId, preview.after);
				else await deps.createTxt(env, domain.zoneId, `_dmarc.${domain.hostname}`, preview.after);
			} catch (error) {
				console.error(`DMARC record edit failed for ${domain.hostname}`, error);
				// Reporting stays off, so the rule created a moment ago must not stay behind.
				if (routed) await deps.deleteRoute(env, domain.zoneId, address).catch((cause) => console.error(`DMARC report routing rule rollback failed for ${domain.hostname}`, cause));
				return fail(502, "DNS_FAILED", "Could not change the DMARC record; it was left as it was");
			}
		}
		if (!enabled && viaCloudflare) await deps.deleteRoute(env, domain.zoneId, address).catch((error) => console.error(`DMARC report routing rule removal failed for ${domain.hostname}`, error));
		// Remember a record we created, so turning off can delete it again; forget it once it is gone or was edited by us.
		const createdRecord = enabled ? (preview.changed && !preview.manual && !recordId ? preview.after : preview.changed ? null : undefined) : null;
		const alertValue = typeof alertEmail === "boolean" ? { alertEmail } : {};
		await save(env, domain.id, enabled ? { reportsEnabled: true, reportsEnabledAt: new Date(), ...alertValue, ...(createdRecord === undefined ? {} : { dmarcCreatedRecord: createdRecord }) } : { reportsEnabled: false, ...alertValue, dmarcCreatedRecord: null });
		return { kind: "ok", state: await getReportState(env, domain), plan: preview };
	}

	await save(env, domain.id, { alertEmail: alertEmail as boolean });
	return { kind: "ok", state: await getReportState(env, domain) };
}

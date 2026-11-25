import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { domainDeliverability } from "@/db/schema";
import { hasTlsRuaUri, withoutTlsRuaUri, withTlsRuaUri } from "./dmarc-record";
import { DnsReadError, isManual, isZoneUnavailable, MultipleRecordsError, readTxtRecord, reportsDeps, type ReportsDeps } from "./reports-admin";
import { reportAddress } from "./report-address";

type Domain = { id: string; hostname: string; zoneId: string };

export type TlsRptPlan = { address: string; before: string | null; after: string | null; changed: boolean; manual: boolean };
/** `reportsEnabled`: DMARC reports are on, which TLS reports need (same address). */
export type TlsRptState = { address: string; enabled: boolean; reportsEnabled: boolean };
export type TlsRptResult =
	| { kind: "ok"; state: TlsRptState; plan: TlsRptPlan }
	| { kind: "error"; status: number; code: string; message: string };

const fail = (status: number, code: string, message: string): TlsRptResult => ({ kind: "error", status, code, message });
const isTlsRpt = (content: string) => /^\s*v=TLSRPTv1\s*(?:;|$)/i.test(content);
/** A TLS-RPT record without a destination is useless to senders, whatever other tags it keeps. */
const hasDestination = (content: string) => /(?:^|;)\s*rua\s*=\s*[^;\s]/i.test(content);

export async function getTlsRptState(env: CloudflareEnv, domain: Pick<Domain, "id" | "hostname">): Promise<TlsRptState> {
	const [row] = await getDb(env).select({ enabled: domainDeliverability.tlsRptEnabled, reportsEnabled: domainDeliverability.reportsEnabled }).from(domainDeliverability).where(eq(domainDeliverability.domainId, domain.id)).limit(1);
	return { address: reportAddress(domain.hostname), enabled: row?.enabled ?? false, reportsEnabled: row?.reportsEnabled ?? false };
}

/**
 * Turns TLS-RPT reporting on or off: adds or removes only our `mailto:` destination in the `_smtp._tls` TXT record, keeping
 * every other destination and tag. Reports arrive at the DMARC report address, so DMARC reporting must be on first (and
 * stay on, see `updateReports`). The setting changes only after DNS did; a failed edit leaves both as they were.
 */
export async function updateTlsRpt(env: CloudflareEnv, domain: Domain, body: unknown, deps: ReportsDeps = reportsDeps): Promise<TlsRptResult> {
	const enabled = body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>).enabled : undefined;
	if (typeof enabled !== "boolean") return fail(400, "INVALID_BODY", "Expected { enabled: boolean }");
	const db = getDb(env);
	if (enabled) {
		const [row] = await db.select({ reports: domainDeliverability.reportsEnabled }).from(domainDeliverability).where(eq(domainDeliverability.domainId, domain.id)).limit(1);
		if (!row?.reports) return fail(409, "REPORTS_REQUIRED", "Turn on DMARC reports first; TLS reports arrive at the same address");
	}
	const address = reportAddress(domain.hostname);
	const name = `_smtp._tls.${domain.hostname}`;
	let current: { id: string | null; content: string } | null;
	try {
		current = await readTxtRecord(env, domain, name, isTlsRpt, deps);
	} catch (error) {
		if (error instanceof MultipleRecordsError) return fail(409, "MULTIPLE_TLSRPT_RECORDS", "More than one TLS-RPT record exists; remove the extra ones first");
		if (!enabled && isZoneUnavailable(error)) return updateTlsRpt(env, { ...domain, zoneId: "manual" }, body, deps);
		if (error instanceof DnsReadError) return fail(502, "DNS_FAILED", "Could not read the current TLS-RPT record");
		throw error;
	}
	const before = current?.content ?? null;
	let after: string | null;
	if (enabled) after = current ? withTlsRuaUri(current.content, address) : `v=TLSRPTv1; rua=mailto:${address}`;
	else {
		const rest = current ? withoutTlsRuaUri(current.content, address) : null;
		// Only a record that held our address is ours to delete once it has no destination left.
		after = current && rest !== null && hasTlsRuaUri(current.content, address) && !hasDestination(rest) ? null : rest;
	}
	const plan: TlsRptPlan = { address, before, after, changed: after !== before, manual: isManual(domain) };
	if (plan.changed && !plan.manual) {
		try {
			if (after === null) await deps.deleteTxt(env, domain.zoneId, current?.id as string);
			else if (current?.id) await deps.updateTxt(env, domain.zoneId, current.id, after);
			else await deps.createTxt(env, domain.zoneId, name, after);
		} catch (error) {
			if (!enabled && isZoneUnavailable(error)) return updateTlsRpt(env, { ...domain, zoneId: "manual" }, body, deps);
			console.error(`TLS-RPT record edit failed for ${domain.hostname}`, error);
			return fail(502, "DNS_FAILED", "Could not change the TLS-RPT record; it was left as it was");
		}
	}
	const now = new Date();
	await db.insert(domainDeliverability).values({ domainId: domain.id, tlsRptEnabled: enabled, updatedAt: now })
		.onConflictDoUpdate({ target: domainDeliverability.domainId, set: { tlsRptEnabled: enabled, updatedAt: now } });
	return { kind: "ok", state: await getTlsRptState(env, domain), plan };
}

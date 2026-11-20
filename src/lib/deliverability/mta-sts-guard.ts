import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { domainDeliverability, domains } from "@/db/schema";
import { isMissingColumnError, isMissingTableError } from "@/lib/database-errors";
import { deleteMtaStsRecord, mtaStsDeps, updateMtaSts, type MtaStsDeps } from "./mta-sts-admin";
import { isManual, reportsDeps, type ReportsDeps } from "./reports-admin";
import { updateTlsRpt } from "./tls-rpt-admin";

type Domain = { id: string; hostname: string; zoneId: string };

/** An action refused because it would break what MTA-STS or TLS reporting published for the domain. Routes answer 409 with a translated message for `code`. */
export class MtaStsBlockedError extends Error {
	readonly status = 409;
	constructor(readonly code: "MTA_STS_ENFORCED" | "MTA_STS_PUBLISHED" | "TLS_RPT_ENABLED", message: string) {
		super(message);
	}
}

/** A forced delete without the typed host name. A 400 in the routes. */
export class ForceDeleteConfirmError extends Error {
	readonly status = 400;
}

async function readPolicy(env: CloudflareEnv, domainId: string) {
	try {
		const [row] = await getDb(env).select({ mode: domainDeliverability.mtaStsMode, policyId: domainDeliverability.mtaStsPolicyId, tlsRpt: domainDeliverability.tlsRptEnabled, maxAge: domainDeliverability.mtaStsMaxAge, servedMaxAge: domainDeliverability.mtaStsServedMaxAge })
			.from(domainDeliverability).where(eq(domainDeliverability.domainId, domainId)).limit(1);
		return row ?? null;
	} catch (error) {
		// Before the migration nothing is published, so nothing can be broken.
		if (isMissingTableError(error) || isMissingColumnError(error)) return null;
		throw error;
	}
}

/**
 * Call before anything that changes the domain's MX records or who receives its mail. While the policy is in enforce,
 * senders refuse any MX host the policy does not list, so the change would bounce mail until the policy catches up.
 */
export async function assertMxChangeAllowed(env: CloudflareEnv, domain: Pick<Domain, "id">): Promise<void> {
	const row = await readPolicy(env, domain.id);
	if (row?.policyId && row.mode === "enforce") throw new MtaStsBlockedError("MTA_STS_ENFORCED", "MTA-STS is in enforce mode for this domain. Switch MTA-STS to testing first.");
}

/**
 * Call after an MX change succeeded. A policy in testing mode is published again with the zone's MX list under a new id
 * (the zone is read directly: a resolver may still answer with the old records); any other state needs nothing. A failure
 * is logged, never thrown: the MX change is done, and the MTA-STS tab shows the mismatch.
 */
export async function republishMtaStsAfterMxChange(env: CloudflareEnv, domain: Domain, deps: MtaStsDeps = mtaStsDeps, now: Date = new Date()): Promise<void> {
	try {
		const row = await readPolicy(env, domain.id);
		if (!row?.policyId || row.mode !== "testing") return;
		// The zone may have changed during the MX change itself (a domain adopted from a manual zone).
		const [current] = await getDb(env).select({ zoneId: domains.zoneId }).from(domains).where(eq(domains.id, domain.id)).limit(1);
		const target = { ...domain, zoneId: current?.zoneId ?? domain.zoneId };
		if (isManual(target)) return;
		const result = await updateMtaSts(env, target, { mode: "testing" }, { ...deps, queryMx: () => deps.zoneMx(env, target) }, now);
		if (result.kind === "error") console.error(`MTA-STS republish after an MX change failed for ${domain.hostname}: ${result.code}`);
	} catch (error) {
		console.error(`MTA-STS republish after an MX change failed for ${domain.hostname}`, error);
	}
}

/**
 * Call before deleting a domain. A published policy (testing, enforce, or the removal period) keeps senders caching it,
 * and deleting the domain would stop the host answering: MTA-STS must be turned off and run out first. Our report address
 * is removed from `_smtp._tls`; when that cannot be done (a zone we do not manage, or DNS refuses) the deletion waits for
 * the admin to turn TLS reports off.
 */
export async function assertDomainRemovable(env: CloudflareEnv, domain: Domain, deps: ReportsDeps = reportsDeps): Promise<void> {
	const row = await readPolicy(env, domain.id);
	if (!row) return;
	if (row.policyId) throw new MtaStsBlockedError("MTA_STS_PUBLISHED", "An MTA-STS policy is published for this domain. Turn MTA-STS off and let the removal period end first.");
	if (!row.tlsRpt) return;
	const blocked = new MtaStsBlockedError("TLS_RPT_ENABLED", "TLS reports are on for this domain. Turn them off and remove the _smtp._tls record first.");
	if (isManual(domain)) throw blocked;
	const result = await updateTlsRpt(env, domain, { enabled: false }, deps);
	// A zone Cloudflare no longer serves ends up as a manual one: TLS reports are off now, the record is for the admin to remove.
	if (result.kind === "error" || result.plan.manual) throw blocked;
}

export type ForceCleanup = { leftovers: { name: string; type: string }[]; cachedUntil: string | null };

/**
 * For a forced delete, which skips `assertDomainRemovable`: tries to take our records out of DNS (`_mta-sts`, our address
 * in `_smtp._tls`) and never throws, whatever fails is logged. Returns the records the admin has to remove by hand (the
 * ones that could not be removed, and the `mta-sts` host record, which the admin created) and the latest date senders
 * that fetched the policy a moment ago may still apply it from their cache.
 */
export async function forceCleanupMtaSts(env: CloudflareEnv, domain: Domain, deps: MtaStsDeps = mtaStsDeps, now: Date = new Date()): Promise<ForceCleanup> {
	const result: ForceCleanup = { leftovers: [], cachedUntil: null };
	const row = await readPolicy(env, domain.id).catch((error) => {
		console.error(`Forced delete: could not read the MTA-STS state of ${domain.hostname}`, error);
		return null;
	});
	if (!row) return result;
	if (row.policyId) {
		const removed = await deleteMtaStsRecord(env, domain, deps).catch((error) => {
			console.error(`Forced delete: could not remove the _mta-sts record of ${domain.hostname}`, error);
			return false;
		});
		if (!removed) result.leftovers.push({ name: `_mta-sts.${domain.hostname}`, type: "TXT" });
		result.leftovers.push({ name: `mta-sts.${domain.hostname}`, type: "A/CNAME" });
		result.cachedUntil = new Date(now.getTime() + Math.max(row.servedMaxAge ?? 0, row.maxAge ?? 0) * 1000).toISOString();
	}
	if (row.tlsRpt) {
		const outcome = await updateTlsRpt(env, domain, { enabled: false }, deps).catch((error) => {
			console.error(`Forced delete: could not remove the _smtp._tls address of ${domain.hostname}`, error);
			return null;
		});
		if (outcome?.kind === "error") console.error(`Forced delete: TLS reports of ${domain.hostname} stay on in DNS: ${outcome.code}`);
		if (outcome?.kind !== "ok" || outcome.plan.manual) result.leftovers.push({ name: `_smtp._tls.${domain.hostname}`, type: "TXT" });
	}
	return result;
}

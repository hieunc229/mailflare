import { and, eq, gte, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { deliverabilityReports, dmarcDailyStats, domainDeliverability } from "@/db/schema";
import { isUniqueConstraintError } from "@/lib/database-errors";
import { queryDns, reverseName } from "@/lib/dns-query";
import { parseRawMime } from "@/lib/email/parse";
import { addressOrganisation } from "./org-domain";
import { extractReportXml, parseDmarcAggregateXml, rawReportKey, REPORT_LIMITS, ReportError, reportKey, rowKey, type DmarcReport } from "./report-parse";

export const INGEST_LIMITS = Object.freeze({
	/** Report rows per domain and UTC day from mail that did not pass DMARC. Such a report can never be verified, so it is only ever a row. */
	unauthenticatedReportsPerDay: 300,
	/** Report rows per domain and UTC day from mail that passed DMARC: per sending organisation, and in total. */
	authenticatedReportsPerSenderPerDay: 300,
	authenticatedReportsPerDay: 2000,
	/** Aggregate rows written by verified reports per domain and UTC day, and per verified reporter. Over budget a report is recorded without rows. */
	statsRowsPerDomainPerDay: 5000,
	statsRowsPerReporterPerDay: 1000,
	/** Reverse lookups per report. A queue batch (5 messages on Workers) shares `ptrLookupsPerBatch`; each lookup is a subrequest. */
	ptrLookups: 5,
	ptrLookupsPerBatch: 10,
	ptrBudgetMs: 2000,
	/** D1 allows 100 bound parameters per statement; one aggregate row binds 12. Batches stay small too. */
	batchStatements: 50,
	errorChars: 300,
});

export type BatchBudget = { ptrLookups: number };
/** One per queue batch, so the reverse lookups of every report in it stay within the invocation's subrequests. */
export const createBatchBudget = (): BatchBudget => ({ ptrLookups: INGEST_LIMITS.ptrLookupsPerBatch });

export type IngestDeps = {
	now?: Date;
	lookupPtr?: (ip: string) => Promise<string | null>;
	ptrBudgetMs?: number;
	batchBudget?: BatchBudget;
};

type Target = { domainId: string; hostname: string };
/** `from` is the From header of the report mail, the one DMARC aligned the `authenticated` verdict to. */
type Input = { rawR2Key: string; authenticated: boolean; from: string | null };

async function defaultLookupPtr(ip: string): Promise<string | null> {
	const name = reverseName(ip);
	if (!name) return null;
	return (await queryDns(name, "PTR"))[0] ?? null;
}

/** A host name only: report IPs are attacker-chosen, so whatever their reverse zone says is cleaned before it is stored. */
function cleanHost(value: string | null): string | null {
	const host = value?.trim().toLowerCase().replace(/\.$/, "") ?? "";
	return host && host.length <= REPORT_LIMITS.domain && /^[a-z0-9._-]+$/.test(host) ? host : null;
}

/** Reverse-DNS names for the highest-volume sources, within one shared time budget. Failures and slow answers are skipped. */
async function resolveHosts(report: DmarcReport, deps: IngestDeps): Promise<Map<string, string>> {
	const lookup = deps.lookupPtr ?? defaultLookupPtr;
	const hosts = new Map<string, string>();
	const allowed = Math.min(INGEST_LIMITS.ptrLookups, deps.batchBudget?.ptrLookups ?? INGEST_LIMITS.ptrLookups);
	const ips = [...new Set(report.rows.map((row) => row.sourceIp))].slice(0, allowed);
	if (deps.batchBudget) deps.batchBudget.ptrLookups -= ips.length;
	let timer: ReturnType<typeof setTimeout> | undefined;
	const budget = new Promise<void>((resolve) => { timer = setTimeout(resolve, deps.ptrBudgetMs ?? INGEST_LIMITS.ptrBudgetMs); });
	const done = Promise.all(ips.map(async (ip) => {
		const host = cleanHost(await lookup(ip).catch(() => null));
		if (host) hosts.set(ip, host);
	}));
	try {
		await Promise.race([done, budget]);
	} finally {
		clearTimeout(timer);
	}
	return new Map(hosts);
}

function reportBytes(parsed: Awaited<ReturnType<typeof parseRawMime>>): Uint8Array {
	const attachment = parsed.attachments[0];
	if (attachment) return new Uint8Array(attachment.content);
	const body = parsed.text?.trimStart() ?? "";
	if (body.startsWith("<?xml") || body.startsWith("<feedback")) return new TextEncoder().encode(body);
	throw new ReportError("rejected", "No report attachment");
}

const startOfUtcDay = (now: Date) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

const sum = (value: unknown) => Number(value ?? 0);

/**
 * Reads one DMARC aggregate report mail from the bucket into the report and daily aggregate tables.
 *
 * Report mail is attacker-controlled. A report is a "verified reporter" only when the mail passed DMARC AND its
 * From organisation equals the organisation of the contact email inside the report; only verified reports write
 * aggregates, under daily row budgets, and everything else is just a row for the page. A bad report is recorded
 * as `failed`/`rejected` and never thrown (a retry would repeat the same work); only a database error before
 * anything is written throws, so the queue retries it.
 *
 * Order: counted against the daily caps, a `processing` row is committed under the raw object's key, then the
 * mail is parsed (the expensive, killable step), then the row is completed under the report's own key (unique
 * per domain, so a redelivery or duplicate stops there). A row still `processing` on redelivery was killed
 * mid-run and is marked failed, not retried.
 */
export async function ingestReportMail(env: CloudflareEnv, target: Target, input: Input, deps: IngestDeps = {}): Promise<void> {
	const db = getDb(env);
	const now = deps.now ?? new Date();
	const dropRaw = () => env.BUCKET.delete(input.rawR2Key).catch((error) => console.error(`Report raw cleanup failed for ${input.rawR2Key}`, error));
	const senderDomain = input.authenticated ? addressOrganisation(input.from) : null;
	const reports = deliverabilityReports;
	const today = and(eq(reports.domainId, target.domainId), gte(reports.receivedAt, startOfUtcDay(now)));

	const [counted] = await db.select({
		total: sql<number>`count(*)`,
		authenticated: sql<number>`coalesce(sum(case when ${reports.authenticated} then 1 else 0 end), 0)`,
		sender: sql<number>`coalesce(sum(case when ${reports.authenticated} and ${reports.senderDomain} = ${senderDomain ?? ""} then 1 else 0 end), 0)`,
	}).from(reports).where(today);
	const authenticatedToday = sum(counted?.authenticated);
	const overCap = input.authenticated
		? authenticatedToday >= INGEST_LIMITS.authenticatedReportsPerDay || (senderDomain !== null && sum(counted?.sender) >= INGEST_LIMITS.authenticatedReportsPerSenderPerDay)
		: sum(counted?.total) - authenticatedToday >= INGEST_LIMITS.unauthenticatedReportsPerDay;
	if (overCap) {
		console.warn(`DMARC report dropped: ${target.hostname} reached its daily report cap`);
		await dropRaw();
		return;
	}

	const object = await env.BUCKET.get(input.rawR2Key);
	if (!object) {
		console.error(`Missing R2 object: ${input.rawR2Key}`);
		return;
	}

	const reportId = crypto.randomUUID();
	const [placeholder] = await db.insert(reports).values({
		id: reportId,
		domainId: target.domainId,
		reportKey: await rawReportKey(input.rawR2Key),
		authenticated: input.authenticated,
		senderDomain,
		status: "processing",
		receivedAt: now,
	}).onConflictDoNothing({ target: [reports.domainId, reports.reportKey] }).returning({ id: reports.id });
	if (!placeholder) {
		// A previous run for this very mail was killed before it finished. It may have written some aggregates, so it is not repeated.
		await db.update(reports).set({ status: "failed", error: "Processing was interrupted" }).where(and(eq(reports.domainId, target.domainId), eq(reports.reportKey, await rawReportKey(input.rawR2Key)), eq(reports.status, "processing")));
		await dropRaw();
		return;
	}
	const finish = (status: "rejected" | "failed", error: string) => db.update(reports).set({ status, error: error.slice(0, INGEST_LIMITS.errorChars) }).where(eq(reports.id, reportId));

	let report: DmarcReport;
	try {
		if (object.size > REPORT_LIMITS.rawMessageBytes) throw new ReportError("rejected", "Report mail exceeds the size limit");
		const parsed = await parseRawMime(await object.arrayBuffer());
		report = parseDmarcAggregateXml(await extractReportXml(reportBytes(parsed)), { hostname: target.hostname, now });
	} catch (error) {
		const failure = error instanceof ReportError ? error : new ReportError("failed", `Could not read the report: ${error instanceof Error ? error.message : "unknown error"}`);
		await finish(failure.status, failure.message);
		await dropRaw();
		return;
	}

	const verified = senderDomain !== null && addressOrganisation(report.reporterEmail) === senderDomain;
	const reporter = verified ? senderDomain : report.reporterOrg;
	let overBudget = false;
	if (verified) {
		const [used] = await db.select({
			domain: sql<number>`coalesce(sum(${reports.statsRows}), 0)`,
			reporter: sql<number>`coalesce(sum(case when ${reports.senderDomain} = ${senderDomain} then ${reports.statsRows} else 0 end), 0)`,
		}).from(reports).where(and(today, eq(reports.verifiedReporter, true)));
		overBudget = sum(used?.domain) + report.rows.length > INGEST_LIMITS.statsRowsPerDomainPerDay || sum(used?.reporter) + report.rows.length > INGEST_LIMITS.statsRowsPerReporterPerDay;
	}
	const status = !verified ? "unverified" : overBudget ? "over_budget" : "processing";
	try {
		await db.update(reports).set({
			reportKey: await reportKey(reporter, report.reportId, verified),
			reporterOrg: report.reporterOrg,
			reporterEmail: report.reporterEmail,
			externalReportId: report.reportId,
			dateBegin: report.dateBegin,
			dateEnd: report.dateEnd,
			policyP: report.policyP,
			policyPct: report.policyPct,
			recordCount: report.recordCount,
			messageCount: report.messageCount,
			verifiedReporter: verified,
			statsRows: status === "processing" ? report.rows.length : 0,
			status,
			error: status === "over_budget" ? "Over today's aggregate budget; the totals were not recorded" : report.truncated ? `Truncated to the ${REPORT_LIMITS.rows} highest-volume rows` : null,
		}).where(eq(reports.id, reportId));
	} catch (error) {
		await db.delete(reports).where(eq(reports.id, reportId));
		await dropRaw();
		// The same report (or a redelivery) already holds this key.
		if (isUniqueConstraintError(error)) return;
		throw error;
	}
	// Only a verified reporter's mail counts as "a report arrived", so a forger cannot silence the no-reports alert.
	if (verified) await db.update(domainDeliverability).set({ lastReportAt: now }).where(eq(domainDeliverability.domainId, target.domainId));
	if (status !== "processing") {
		await dropRaw();
		return;
	}

	try {
		const hosts = await resolveHosts(report, deps);
		// Keys first: a drizzle query builder is thenable, so it must not be returned from an async callback or it would run.
		const keys = await Promise.all(report.rows.map((row) => rowKey(reporter, row)));
		const statements = report.rows.map((row, index) => db.insert(dmarcDailyStats).values({
			domainId: target.domainId,
			day: report.day,
			rowKey: keys[index],
			sourceIp: row.sourceIp,
			sourceHost: hosts.get(row.sourceIp) ?? null,
			reporterOrg: reporter,
			headerFrom: row.headerFrom,
			disposition: row.disposition,
			dkimAligned: row.dkimAligned,
			spfAligned: row.spfAligned,
			messageCount: row.count,
		}).onConflictDoUpdate({
			target: [dmarcDailyStats.domainId, dmarcDailyStats.day, dmarcDailyStats.rowKey],
			set: { messageCount: sql`${dmarcDailyStats.messageCount} + ${row.count}` },
		}));
		for (let start = 0; start < statements.length; start += INGEST_LIMITS.batchStatements) {
			await db.batch(statements.slice(start, start + INGEST_LIMITS.batchStatements) as [(typeof statements)[number], ...(typeof statements)[number][]]);
		}
		await db.update(reports).set({ status: "ok" }).where(eq(reports.id, reportId));
	} catch (error) {
		// Some aggregates may be written. The report row stays, so a redelivery stops at the conflict instead of
		// counting twice: a failed report undercounts, which is safer than double counting.
		console.error(`DMARC report write failed for ${target.hostname}`, error);
		await db.update(reports).set({ status: "failed", error: "Writing the aggregates was interrupted" }).where(eq(reports.id, reportId)).catch(() => undefined);
	}
	await dropRaw();
}

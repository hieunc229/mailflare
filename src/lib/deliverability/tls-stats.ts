import { and, desc, eq, gte, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { deliverabilityReports, tlsDailyStats as stats } from "@/db/schema";
import type { DmarcDays, DmarcRecentReport } from "./dmarc-stats";

export type TlsSeriesDay = { day: string; success: number; failure: number };
export type TlsStats = {
	days: DmarcDays;
	series: TlsSeriesDay[];
	reporters: { reporterOrg: string; success: number; failure: number }[];
	policies: { policyType: string; mxHost: string | null; success: number; failure: number }[];
	failureTypes: { resultType: string; failure: number }[];
	unverifiedReports: number;
	recentReports: DmarcRecentReport[];
};

const LIMIT = 100;
const DAY_MS = 86_400_000;
const isDay = (date: Date) => date.toISOString().slice(0, 10);
const success = sql<number>`coalesce(sum(${stats.successCount}), 0)`;
const failure = sql<number>`coalesce(sum(${stats.failureCount}), 0)`;

/** Daily totals, per-reporter, per-policy and per-failure-type tables and the latest TLS-RPT reports for one domain. Only verified reporters write rows, so nothing is filtered by trust here. */
export async function getTlsStats(env: CloudflareEnv, domainId: string, options: { days: DmarcDays; now?: Date }): Promise<TlsStats> {
	const db = getDb(env);
	const now = options.now ?? new Date();
	const fromDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - (options.days - 1) * DAY_MS);
	const filter = and(eq(stats.domainId, domainId), gte(stats.day, isDay(fromDate)));
	const reports = and(eq(deliverabilityReports.domainId, domainId), eq(deliverabilityReports.kind, "tlsrpt"));
	const [daily, reporterRows, policyRows, typeRows, [unverified], recent] = await Promise.all([
		db.select({ day: stats.day, success, failure }).from(stats).where(filter).groupBy(stats.day),
		db.select({ reporterOrg: stats.reporterOrg, success, failure }).from(stats).where(filter).groupBy(stats.reporterOrg).orderBy(desc(sql`sum(${stats.successCount}) + sum(${stats.failureCount})`)).limit(LIMIT),
		db.select({ policyType: stats.policyType, mxHost: stats.mxHost, success, failure }).from(stats).where(filter).groupBy(stats.policyType, stats.mxHost).orderBy(desc(sql`sum(${stats.successCount}) + sum(${stats.failureCount})`)).limit(LIMIT),
		db.select({ resultType: stats.resultType, failure }).from(stats).where(and(filter, sql`${stats.failureCount} > 0`)).groupBy(stats.resultType).orderBy(desc(sql`sum(${stats.failureCount})`)).limit(LIMIT),
		db.select({ reports: sql<number>`count(*)` }).from(deliverabilityReports).where(and(reports, eq(deliverabilityReports.status, "unverified"), gte(deliverabilityReports.receivedAt, fromDate))),
		db.select().from(deliverabilityReports).where(reports).orderBy(desc(deliverabilityReports.receivedAt)).limit(10),
	]);
	const byDay = new Map(daily.map((row) => [row.day, row]));
	const series: TlsSeriesDay[] = [];
	for (let index = 0; index < options.days; index += 1) {
		const day = isDay(new Date(fromDate.getTime() + index * DAY_MS));
		series.push({ day, success: Number(byDay.get(day)?.success ?? 0), failure: Number(byDay.get(day)?.failure ?? 0) });
	}
	return {
		days: options.days,
		series,
		reporters: reporterRows.map((row) => ({ reporterOrg: row.reporterOrg, success: Number(row.success), failure: Number(row.failure) })),
		policies: policyRows.map((row) => ({ policyType: row.policyType, mxHost: row.mxHost, success: Number(row.success), failure: Number(row.failure) })),
		failureTypes: typeRows.map((row) => ({ resultType: row.resultType, failure: Number(row.failure) })),
		unverifiedReports: Number(unverified?.reports ?? 0),
		recentReports: recent.map((row) => ({ id: row.id, reporterOrg: row.reporterOrg, dateBegin: row.dateBegin?.toISOString() ?? null, status: row.status, error: row.error, messageCount: row.messageCount, verifiedReporter: row.verifiedReporter, receivedAt: row.receivedAt.toISOString() })),
	};
}

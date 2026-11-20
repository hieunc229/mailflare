import { and, desc, eq, gte, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { deliverabilityReports, dmarcDailyStats as stats } from "@/db/schema";

export type DmarcDays = 7 | 30 | 90;
export type DmarcSeriesDay = { day: string; pass: number; failDelivered: number; quarantined: number; rejected: number };
export type DmarcSource = { sourceIp: string; sourceHost: string | null; messages: number; passMessages: number; dkimMessages: number; spfMessages: number; worstDisposition: "none" | "quarantine" | "reject"; reporters: number };
export type DmarcReporter = { reporterOrg: string; reports: number; messages: number; passMessages: number };
export type DmarcRecentReport = { id: string; reporterOrg: string | null; dateBegin: string | null; status: string; error: string | null; messageCount: number; verifiedReporter: boolean; receivedAt: string };
/** `unverifiedReports`: reports in the range that were not counted because their sender could not be verified. */
export type DmarcStats = { days: DmarcDays; series: DmarcSeriesDay[]; sources: DmarcSource[]; reporters: DmarcReporter[]; unverifiedReports: number; recentReports: DmarcRecentReport[] };

const SOURCE_LIMIT = 100;
const REPORTER_LIMIT = 100;
const DAY_MS = 86_400_000;

export function normalizeDays(value: unknown): DmarcDays {
	const days = Number(value);
	return days === 7 || days === 90 ? days : 30;
}

// DMARC passes when either identifier aligned. Plain boolean expressions keep this portable across the three dialects.
const passed = sql`(${stats.dkimAligned} or ${stats.spfAligned})`;
const total = (condition: ReturnType<typeof sql>) => sql<number>`coalesce(sum(case when ${condition} then ${stats.messageCount} else 0 end), 0)`;
const isDay = (date: Date) => date.toISOString().slice(0, 10);

/**
 * Daily series, per-source and per-reporter tables and the latest reports for one domain over the last 7, 30 or 90
 * days. Aggregates only ever come from verified reporters, so there is nothing to filter by trust here.
 */
export async function getDmarcStats(env: CloudflareEnv, domainId: string, options: { days: DmarcDays; now?: Date }): Promise<DmarcStats> {
	const db = getDb(env);
	const now = options.now ?? new Date();
	const fromDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - (options.days - 1) * DAY_MS);
	const filter = and(eq(stats.domainId, domainId), gte(stats.day, isDay(fromDate)));
	const dmarcReport = eq(deliverabilityReports.kind, "dmarc");
	const reportFilter = and(eq(deliverabilityReports.domainId, domainId), dmarcReport, eq(deliverabilityReports.status, "ok"), gte(deliverabilityReports.dateBegin, fromDate));
	const unverifiedFilter = and(eq(deliverabilityReports.domainId, domainId), dmarcReport, eq(deliverabilityReports.status, "unverified"), gte(deliverabilityReports.receivedAt, fromDate));

	const [daily, sourceRows, reporterRows, reportCounts, [unverified], recent] = await Promise.all([
		db.select({
			day: stats.day,
			pass: total(passed),
			failDelivered: total(sql`not ${passed} and ${stats.disposition} = 'none'`),
			quarantined: total(sql`not ${passed} and ${stats.disposition} = 'quarantine'`),
			rejected: total(sql`not ${passed} and ${stats.disposition} = 'reject'`),
		}).from(stats).where(filter).groupBy(stats.day),
		db.select({
			sourceIp: stats.sourceIp,
			sourceHost: sql<string | null>`max(${stats.sourceHost})`,
			messages: sql<number>`sum(${stats.messageCount})`,
			passMessages: total(passed),
			dkimMessages: total(sql`${stats.dkimAligned}`),
			spfMessages: total(sql`${stats.spfAligned}`),
			worst: sql<number>`max(case ${stats.disposition} when 'reject' then 2 when 'quarantine' then 1 else 0 end)`,
			reporters: sql<number>`count(distinct ${stats.reporterOrg})`,
		}).from(stats).where(filter).groupBy(stats.sourceIp).orderBy(desc(sql`sum(${stats.messageCount})`)).limit(SOURCE_LIMIT),
		db.select({ reporterOrg: stats.reporterOrg, messages: sql<number>`sum(${stats.messageCount})`, passMessages: total(passed) }).from(stats).where(filter).groupBy(stats.reporterOrg).orderBy(desc(sql`sum(${stats.messageCount})`)).limit(REPORTER_LIMIT),
		// Verified reports are grouped by the verified sender, the same name the aggregate rows carry.
		db.select({ reporterOrg: deliverabilityReports.senderDomain, reports: sql<number>`count(*)` }).from(deliverabilityReports).where(reportFilter).groupBy(deliverabilityReports.senderDomain).limit(REPORTER_LIMIT * 2),
		db.select({ reports: sql<number>`count(*)` }).from(deliverabilityReports).where(unverifiedFilter),
		db.select().from(deliverabilityReports).where(and(eq(deliverabilityReports.domainId, domainId), dmarcReport)).orderBy(desc(deliverabilityReports.receivedAt)).limit(10),
	]);

	const byDay = new Map(daily.map((row) => [row.day, row]));
	const series: DmarcSeriesDay[] = [];
	for (let index = 0; index < options.days; index += 1) {
		const day = isDay(new Date(fromDate.getTime() + index * DAY_MS));
		const row = byDay.get(day);
		series.push({ day, pass: Number(row?.pass ?? 0), failDelivered: Number(row?.failDelivered ?? 0), quarantined: Number(row?.quarantined ?? 0), rejected: Number(row?.rejected ?? 0) });
	}
	const reportsBy = new Map(reportCounts.map((row) => [row.reporterOrg, Number(row.reports)]));
	return {
		days: options.days,
		series,
		sources: sourceRows.map((row) => ({
			sourceIp: row.sourceIp,
			sourceHost: row.sourceHost,
			messages: Number(row.messages),
			passMessages: Number(row.passMessages),
			dkimMessages: Number(row.dkimMessages),
			spfMessages: Number(row.spfMessages),
			worstDisposition: Number(row.worst) >= 2 ? "reject" : Number(row.worst) === 1 ? "quarantine" : "none",
			reporters: Number(row.reporters),
		})),
		unverifiedReports: Number(unverified?.reports ?? 0),
		reporters: reporterRows.map((row) => ({ reporterOrg: row.reporterOrg, reports: reportsBy.get(row.reporterOrg) ?? 0, messages: Number(row.messages), passMessages: Number(row.passMessages) })),
		recentReports: recent.map((row) => ({
			id: row.id,
			reporterOrg: row.reporterOrg,
			dateBegin: row.dateBegin?.toISOString() ?? null,
			status: row.status,
			error: row.error,
			messageCount: row.messageCount,
			verifiedReporter: row.verifiedReporter,
			receivedAt: row.receivedAt.toISOString(),
		})),
	};
}

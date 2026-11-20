import { and, desc, eq, inArray, isNotNull, lt, lte, gte, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { deliverabilityAlerts, deliverabilityReports, dmarcDailyStats as stats, domainDeliverability, domains, tlsDailyStats, users } from "@/db/schema";
import { isMissingColumnError, isMissingTableError } from "@/lib/database-errors";
import type { SystemMailInput } from "@/lib/email/system-mail-types";
import { retireMtaSts, type MtaStsDeps } from "./mta-sts-admin";
import { evaluateNoReports, evaluateSourceAlerts, mergeReporterAlerts, type AlertKind, type EvaluatedAlert, type SourceTotals } from "./daily-utils";

export const RETENTION = Object.freeze({
	days: 180,
	/** Rows selected, then deleted in `inArray` chunks, per batch. */
	batchRows: 500,
	/**
	 * Non-empty batches per table and run, so one run's database calls stay bounded and a backlog in one table cannot
	 * use another's share. Each is at least one domain's maximum daily inflow (5,000 aggregate rows; 300 + 2,000
	 * report rows, see INGEST_LIMITS); a larger backlog clears over the following runs.
	 */
	batches: { stats: 12, tls: 12, reports: 6, alerts: 2 },
	/** D1 allows 100 bound parameters per statement. */
	deleteChunk: 90,
});

const DAY_MS = 86_400_000;
/** Sources evaluated per verified reporter, and reporters evaluated per domain, per run. */
const SOURCE_LIMIT = 2000;
const REPORTER_LIMIT = 20;
const isoDay = (date: Date) => date.toISOString().slice(0, 10);

type SendMail = (env: CloudflareEnv, input: SystemMailInput) => Promise<boolean>;

async function defaultSendMail(env: CloudflareEnv, input: SystemMailInput) {
	return (await import("@/lib/email/system-mail")).sendSystemEmail(env, input);
}

/**
 * The reporters that sent aggregates yesterday, at most REPORTER_LIMIT. Reporters with history (distinct report days
 * in the 30 days before yesterday, most first) always come first, so a verified attacker claiming huge volumes from
 * many fresh domains cannot push an established reporter out; new reporters, busiest first, fill the slots left.
 */
async function yesterdaysReporters(env: CloudflareEnv, domainId: string, day: string, priorFrom: string): Promise<string[]> {
	const volume = sql<number>`coalesce(sum(case when ${stats.day} = ${day} then ${stats.messageCount} else 0 end), 0)`;
	const history = sql<number>`count(distinct case when ${stats.day} < ${day} then ${stats.day} end)`;
	const rows = await getDb(env).select({ reporter: stats.reporterOrg, volume, history }).from(stats)
		.where(and(eq(stats.domainId, domainId), gte(stats.day, priorFrom), lte(stats.day, day)))
		.groupBy(stats.reporterOrg).having(sql`sum(case when ${stats.day} = ${day} then 1 else 0 end) > 0`);
	const ranked = rows.map((row) => ({ reporter: row.reporter, volume: Number(row.volume), history: Number(row.history) }));
	const byVolume = (a: { volume: number; reporter: string }, b: { volume: number; reporter: string }) => b.volume - a.volume || a.reporter.localeCompare(b.reporter);
	const established = ranked.filter((row) => row.history > 0).sort((a, b) => b.history - a.history || byVolume(a, b));
	const fresh = ranked.filter((row) => row.history === 0).sort(byVolume);
	return [...established, ...fresh].slice(0, REPORTER_LIMIT).map((row) => row.reporter);
}

/**
 * One reporter's per-source totals for yesterday and for the 30 days before it. The limit is per reporter, so a
 * reporter with thousands of sources cannot push another's out, and only that reporter's own history is consulted.
 */
async function reporterTotals(env: CloudflareEnv, domainId: string, reporter: string, yesterday: string, priorFrom: string): Promise<{ yesterday: SourceTotals[]; prior30: SourceTotals[] }> {
	const passed = sql`(${stats.dkimAligned} or ${stats.spfAligned})`;
	const sumWhen = (condition: ReturnType<typeof sql>, onlyPassed: boolean) => sql<number>`coalesce(sum(case when ${condition}${onlyPassed ? sql` and ${passed}` : sql``} then ${stats.messageCount} else 0 end), 0)`;
	const isYesterday = sql`${stats.day} = ${yesterday}`;
	const isPrior = sql`${stats.day} < ${yesterday}`;
	const rows = await getDb(env).select({
		sourceIp: stats.sourceIp,
		messages: sumWhen(isYesterday, false),
		passMessages: sumWhen(isYesterday, true),
		priorMessages: sumWhen(isPrior, false),
		priorPass: sumWhen(isPrior, true),
	}).from(stats)
		.where(and(eq(stats.domainId, domainId), eq(stats.reporterOrg, reporter), gte(stats.day, priorFrom), lte(stats.day, yesterday)))
		.groupBy(stats.sourceIp).having(sql`sum(case when ${isYesterday} then ${stats.messageCount} else 0 end) > 0`)
		.orderBy(desc(sql`sum(case when ${isYesterday} then ${stats.messageCount} else 0 end)`)).limit(SOURCE_LIMIT);
	return {
		yesterday: rows.map((row) => ({ sourceIp: row.sourceIp, messages: Number(row.messages), passMessages: Number(row.passMessages) })),
		prior30: rows.map((row) => ({ sourceIp: row.sourceIp, messages: Number(row.priorMessages), passMessages: Number(row.priorPass) })),
	};
}

const SUBJECT: Record<AlertKind, string> = {
	spoofing: "possible spoofing of your domain",
	auth_regression: "mail from a trusted source started failing DMARC",
	no_reports: "no DMARC reports are arriving",
};

function alertText(hostname: string, alert: EvaluatedAlert): string {
	const lines = [`Mailflare noticed something about ${hostname}: ${SUBJECT[alert.kind]}.`, ""];
	if ("sources" in alert.detail) {
		for (const source of alert.detail.sources) lines.push(`${source.sourceIp}: ${source.failed} of ${source.messages} messages failed DMARC`);
		if (alert.detail.total > alert.detail.sources.length) lines.push(`and ${alert.detail.total - alert.detail.sources.length} more`);
	} else {
		lines.push(alert.detail.lastReportAt ? `The last report arrived on ${alert.detail.lastReportAt.slice(0, 10)}.` : "No report has arrived yet.");
	}
	lines.push("", "Open Admin, Deliverability to see the details and acknowledge this alert.");
	return lines.join("\n");
}

async function runAlerts(env: CloudflareEnv, now: Date, sendMail: SendMail) {
	const db = getDb(env);
	const enabled = await db.select({
		domainId: domainDeliverability.domainId,
		hostname: domains.hostname,
		ownerId: domains.userId,
		alertEmail: domainDeliverability.alertEmail,
		reportsEnabledAt: domainDeliverability.reportsEnabledAt,
		lastReportAt: domainDeliverability.lastReportAt,
	}).from(domainDeliverability).innerJoin(domains, eq(domains.id, domainDeliverability.domainId)).where(eq(domainDeliverability.reportsEnabled, true));

	const yesterday = isoDay(new Date(now.getTime() - DAY_MS));
	for (const domain of enabled) {
		try {
			const [lastNoReports] = await db.select({ createdAt: deliverabilityAlerts.createdAt }).from(deliverabilityAlerts)
				.where(and(eq(deliverabilityAlerts.domainId, domain.domainId), eq(deliverabilityAlerts.kind, "no_reports"))).orderBy(desc(deliverabilityAlerts.createdAt)).limit(1);
			const priorFrom = isoDay(new Date(now.getTime() - 31 * DAY_MS));
			const parts: { reporter: string; alerts: EvaluatedAlert[] }[] = [];
			for (const reporter of await yesterdaysReporters(env, domain.domainId, yesterday, priorFrom)) {
				parts.push({ reporter, alerts: evaluateSourceAlerts(await reporterTotals(env, domain.domainId, reporter, yesterday, priorFrom)) });
			}
			const noReports = evaluateNoReports({ reportsEnabledAt: domain.reportsEnabledAt, lastReportAt: domain.lastReportAt, lastNoReportsAlertAt: lastNoReports?.createdAt ?? null, now });
			const alerts = [...mergeReporterAlerts(parts), ...(noReports ? [noReports] : [])];
			for (const alert of alerts) {
				const [created] = await db.insert(deliverabilityAlerts).values({
					id: crypto.randomUUID(), domainId: domain.domainId, kind: alert.kind, day: yesterday, detail: JSON.stringify(alert.detail), createdAt: now,
				}).onConflictDoNothing({ target: [deliverabilityAlerts.domainId, deliverabilityAlerts.kind, deliverabilityAlerts.day] }).returning({ id: deliverabilityAlerts.id });
				if (!created || !domain.alertEmail) continue;
				const [owner] = await db.select({ email: users.email }).from(users).where(eq(users.id, domain.ownerId)).limit(1);
				if (!owner) continue;
				await sendMail(env, { to: owner.email, hostname: domain.hostname, subject: `Mailflare: ${SUBJECT[alert.kind]} (${domain.hostname})`, text: alertText(domain.hostname, alert) })
					.catch((error) => console.error(`DMARC alert email failed for ${domain.hostname}`, error));
			}
		} catch (error) {
			console.error(`DMARC alerts failed for ${domain.hostname}`, error);
		}
	}
}

/** Deletes rows matching `where`, 500 ids at a time (selected first, then removed in `inArray` chunks of 90 in one batch). Returns the batches used. */
async function purge(db: ReturnType<typeof getDb>, budget: number, select: (limit: number) => Promise<(string | number)[]>, remove: (ids: never[]) => unknown): Promise<number> {
	let used = 0;
	while (used < budget) {
		const ids = await select(RETENTION.batchRows);
		if (ids.length === 0) break;
		const statements: unknown[] = [];
		for (let start = 0; start < ids.length; start += RETENTION.deleteChunk) statements.push(remove(ids.slice(start, start + RETENTION.deleteChunk) as never[]));
		// The statements must come from the same instance that batches them (see src/db/compat.ts).
		await db.batch(statements as never);
		used += 1;
	}
	return used;
}

async function runRetention(env: CloudflareEnv, now: Date) {
	const db = getDb(env);
	const cutoff = new Date(now.getTime() - RETENTION.days * DAY_MS);
	await purge(db, RETENTION.batches.reports,
		async (limit) => (await db.select({ id: deliverabilityReports.id }).from(deliverabilityReports).where(lt(deliverabilityReports.receivedAt, cutoff)).limit(limit)).map((row) => row.id),
		(ids) => db.delete(deliverabilityReports).where(inArray(deliverabilityReports.id, ids)));
	await purge(db, RETENTION.batches.stats,
		async (limit) => (await db.select({ id: stats.id }).from(stats).where(lt(stats.day, isoDay(cutoff))).limit(limit)).map((row) => row.id),
		(ids) => db.delete(stats).where(inArray(stats.id, ids)));
	await purge(db, RETENTION.batches.tls,
		async (limit) => (await db.select({ id: tlsDailyStats.id }).from(tlsDailyStats).where(lt(tlsDailyStats.day, isoDay(cutoff))).limit(limit)).map((row) => row.id),
		(ids) => db.delete(tlsDailyStats).where(inArray(tlsDailyStats.id, ids)));
	await purge(db, RETENTION.batches.alerts,
		async (limit) => (await db.select({ id: deliverabilityAlerts.id }).from(deliverabilityAlerts).where(and(isNotNull(deliverabilityAlerts.acknowledgedAt), lt(deliverabilityAlerts.createdAt, cutoff))).limit(limit)).map((row) => row.id),
		(ids) => db.delete(deliverabilityAlerts).where(inArray(deliverabilityAlerts.id, ids)));
}

/**
 * The daily deliverability job (02:00 UTC): DMARC alerts for domains with reporting on, retention, and the end of MTA-STS removal periods. Alerts are deduplicated by
 * (domain, kind, day), so a re-run never repeats one or its email. Does nothing before the migration is applied.
 */
export async function runDeliverabilityDaily(env: CloudflareEnv, now: Date = new Date(), deps: { sendMail?: SendMail; mtaStsDeps?: MtaStsDeps } = {}): Promise<void> {
	// Independent steps: one failing (or one whose migration is not applied yet) never skips the others.
	let failure: unknown;
	for (const step of [
		() => runAlerts(env, now, deps.sendMail ?? defaultSendMail),
		() => runRetention(env, now),
		() => (deps.mtaStsDeps ? retireMtaSts(env, now, deps.mtaStsDeps) : retireMtaSts(env, now)),
	]) {
		try {
			await step();
		} catch (error) {
			if (!isMissingTableError(error) && !isMissingColumnError(error)) failure ??= error;
		}
	}
	if (failure) throw failure;
}

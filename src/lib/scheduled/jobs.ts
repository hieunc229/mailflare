import { runAccountRetention } from "@/lib/accounts/deletion";
import { runAgentMaintenance } from "@/lib/agent/maintenance";
import { purgeExpiredAuthRows } from "@/lib/auth/purge";
import { runScheduledDatabaseBackup } from "@/lib/backups/runner";
import { runCalendarReminders } from "@/lib/calendar/reminders";
import { runDavChangeRetention } from "@/lib/dav/changes";
import { runDeliverabilityDaily } from "@/lib/deliverability/daily";
import { runDriveTrashRetention } from "@/lib/drive/retention";
import { sweepOrphanedRawMail } from "@/lib/email/raw-sweeper";
import { runTrashRetention } from "@/lib/email/trash-retention";
import { runFollowUpReminders } from "@/lib/follow-ups/service";
import { sweepImportJobs } from "@/lib/import/jobs";
import { runJmapChangeRetention } from "@/lib/jmap/changes";
import { pruneExpiredMessageActionUndoClaims } from "@/lib/messages/actions/claims";
import { runPromotionsBackfill } from "@/lib/promotions/backfill";
import type { ScheduledJob } from "./jobs-types";

/*
 * The recurring jobs of every runtime: the Worker cron triggers (worker.ts), the self-hosted scheduler
 * (server/runtime/scheduler.ts) and the Vercel cron routes. Add a new job here and all three run it.
 * The self-hosted server is a plain Node bundle, so nothing imported here may import `next/server` or
 * `next/headers`; such a job gets its own file (auto-update-job.ts).
 */

/** Every five minutes on Workers and Vercel; every minute when self-hosted, except where marked. */
export function frequentJobs(env: CloudflareEnv, now: Date): ScheduledJob[] {
	return [
		{ name: "Agent maintenance", run: () => runAgentMaintenance(env) },
		{ name: "Trash retention", run: () => runTrashRetention(env, now) },
		{ name: "Follow-up reminders", run: () => runFollowUpReminders(env, now) },
		{ name: "Calendar reminders", run: () => runCalendarReminders(env, now) },
		// Its daily row budget assumes one run per five minutes.
		{ name: "Promotions backfill", run: () => runPromotionsBackfill(env, now), everyFiveMinutes: true },
		{ name: "Import job sweep", run: () => sweepImportJobs(env, now) },
		{ name: "Undo claim prune", run: () => pruneExpiredMessageActionUndoClaims(env, now) },
		// Takes a small slice per run (one collection, 90 rows), so it runs on every tick.
		{ name: "DAV change retention", run: () => runDavChangeRetention(env, now) },
	];
}

/** Once a day at 02:00 UTC. */
export function dailyJobs(env: CloudflareEnv, now: Date): ScheduledJob[] {
	return [
		{ name: "Scheduled backup", run: () => runScheduledDatabaseBackup(env, now) },
		{ name: "Account retention", run: () => runAccountRetention(env, now) },
		{ name: "Expired auth row purge", run: () => purgeExpiredAuthRows(env, now) },
		{ name: "Drive trash retention", run: () => runDriveTrashRetention(env, now) },
		{ name: "JMAP change retention", run: () => runJmapChangeRetention(env, now) },
		{ name: "Deliverability daily job", run: () => runDeliverabilityDaily(env, now) },
		{ name: "Raw mail sweep", run: () => sweepOrphanedRawMail(env, now) },
	];
}

/** Runs one job, logging instead of throwing, so one failure never stops the others. False when it failed. */
export async function runScheduledJob(job: ScheduledJob): Promise<boolean> {
	try {
		await job.run();
		return true;
	} catch (error) {
		console.error(`${job.name} failed`, error);
		return false;
	}
}

import { runScheduledDatabaseBackup } from "@/lib/backups/runner";
import { runAgentMaintenance } from "@/lib/agent/maintenance";
import { runTrashRetention } from "@/lib/email/trash-retention";
import { runDriveTrashRetention } from "@/lib/drive/retention";
import { runAccountRetention } from "@/lib/accounts/deletion";
import { purgeExpiredAuthRows } from "@/lib/auth/purge";
import { runJmapChangeRetention } from "@/lib/jmap/changes";
import { runFollowUpReminders } from "@/lib/follow-ups/service";
import { runCalendarReminders } from "@/lib/calendar/reminders";
import { sweepImportJobs } from "@/lib/import/jobs";
import { sweepOrphanedRawMail } from "@/lib/email/raw-sweeper";
import { sweepOrphanedImapCache } from "@/lib/imap/cache-sweeper";
import { pruneImapExpunged } from "@/lib/imap/expunge-prune";
import { pruneExpiredMessageActionUndoClaims } from "@/lib/messages/actions/claims";

/** Fire the daily 02:00 UTC backup and the recurring maintenance jobs, matching the cron triggers in wrangler.jsonc. */
export function startScheduler(env: CloudflareEnv) {
	let lastRunDay = "";
	const timer = setInterval(() => {
		runAgentMaintenance(env).catch((error) => console.error("Agent maintenance failed", error));
		runTrashRetention(env).catch((error) => console.error("Trash retention failed", error));
		sweepImportJobs(env).catch((error) => console.error("Import job sweep failed", error));
		pruneExpiredMessageActionUndoClaims(env).catch((error) => console.error("Undo claim prune failed", error));
		const now = new Date();
		runFollowUpReminders(env, now).catch((error) => console.error("Follow-up reminders failed", error));
		runCalendarReminders(env, now).catch((error) => console.error("Calendar reminders failed", error));
		const day = now.toISOString().slice(0, 10);
		if (now.getUTCHours() !== 2 || lastRunDay === day) return;
		lastRunDay = day;
		runScheduledDatabaseBackup(env, now).catch((error) => console.error("Scheduled backup failed", error));
		runDriveTrashRetention(env, now).catch((error) => console.error("Drive trash retention failed", error));
		runAccountRetention(env, now).catch((error) => console.error("Account retention failed", error));
		purgeExpiredAuthRows(env, now).catch((error) => console.error("Expired auth row purge failed", error));
		runJmapChangeRetention(env, now).catch((error) => console.error("JMAP change retention failed", error));
		sweepOrphanedRawMail(env, now).catch((error) => console.error("Raw mail sweep failed", error));
		// Daily, and only when IMAP is on: with it off the expunge log is never written and there is nothing to prune.
		if (process.env.IMAP_ENABLED === "1") pruneImapExpunged(env, now).catch((error) => console.error("IMAP expunge log prune failed", error));
		// Weekly (Sunday), and only when IMAP is on: with it off this adds no storage listing.
		if (process.env.IMAP_ENABLED === "1" && now.getUTCDay() === 0) sweepOrphanedImapCache(env, now).catch((error) => console.error("IMAP cache sweep failed", error));
	}, 60_000);
	return () => clearInterval(timer);
}

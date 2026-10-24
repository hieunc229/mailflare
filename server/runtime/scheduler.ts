import { runScheduledDatabaseBackup } from "@/lib/backups/runner";
import { runAgentMaintenance } from "@/lib/agent/maintenance";
import { runTrashRetention } from "@/lib/email/trash-retention";
import { runDriveTrashRetention } from "@/lib/drive/retention";
import { runAccountRetention } from "@/lib/accounts/deletion";
import { runJmapChangeRetention } from "@/lib/jmap/changes";
import { sweepImportJobs } from "@/lib/import/jobs";

/** Fire the daily 02:00 UTC backup and the recurring maintenance jobs, matching the cron triggers in wrangler.jsonc. */
export function startScheduler(env: CloudflareEnv) {
	let lastRunDay = "";
	const timer = setInterval(() => {
		runAgentMaintenance(env).catch((error) => console.error("Agent maintenance failed", error));
		runTrashRetention(env).catch((error) => console.error("Trash retention failed", error));
		sweepImportJobs(env).catch((error) => console.error("Import job sweep failed", error));
		const now = new Date();
		const day = now.toISOString().slice(0, 10);
		if (now.getUTCHours() !== 2 || lastRunDay === day) return;
		lastRunDay = day;
		runScheduledDatabaseBackup(env, now).catch((error) => console.error("Scheduled backup failed", error));
		runDriveTrashRetention(env, now).catch((error) => console.error("Drive trash retention failed", error));
		runAccountRetention(env, now).catch((error) => console.error("Account retention failed", error));
		runJmapChangeRetention(env, now).catch((error) => console.error("JMAP change retention failed", error));
	}, 60_000);
	return () => clearInterval(timer);
}

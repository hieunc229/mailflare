import { runScheduledDatabaseBackup } from "@/lib/backups/runner";

/** Fire the daily 02:00 UTC backup, matching the cron trigger in wrangler.jsonc. */
export function startScheduler(env: CloudflareEnv) {
	let lastRunDay = "";
	const timer = setInterval(() => {
		const now = new Date();
		const day = now.toISOString().slice(0, 10);
		if (now.getUTCHours() !== 2 || lastRunDay === day) return;
		lastRunDay = day;
		runScheduledDatabaseBackup(env, now).catch((error) => console.error("Scheduled backup failed", error));
	}, 60_000);
	return () => clearInterval(timer);
}

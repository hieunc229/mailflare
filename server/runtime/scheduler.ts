import { sweepOrphanedImapCache } from "@/lib/imap/cache-sweeper";
import { dailyJobs, frequentJobs, runScheduledJob } from "@/lib/scheduled/jobs";

/** Jobs marked `everyFiveMinutes` assume the Worker cron's cadence; this loop ticks every minute. */
const FIVE_MINUTES_MS = 5 * 60_000;

/** Fire the daily 02:00 UTC backup and the recurring maintenance jobs, matching the cron triggers in wrangler.jsonc. */
export function startScheduler(env: CloudflareEnv) {
	let lastRunDay = "";
	let lastSpacedRunAt = 0;
	const timer = setInterval(() => {
		const now = new Date();
		const spacedDue = now.getTime() - lastSpacedRunAt >= FIVE_MINUTES_MS;
		if (spacedDue) lastSpacedRunAt = now.getTime();
		for (const job of frequentJobs(env, now)) {
			if (!job.everyFiveMinutes || spacedDue) void runScheduledJob(job);
		}
		const day = now.toISOString().slice(0, 10);
		if (now.getUTCHours() !== 2 || lastRunDay === day) return;
		lastRunDay = day;
		for (const job of dailyJobs(env, now)) void runScheduledJob(job);
		// Weekly (Sunday), self-hosted only, and only when IMAP is on: with it off this adds no storage listing.
		if (process.env.IMAP_ENABLED === "1" && now.getUTCDay() === 0) void runScheduledJob({ name: "IMAP cache sweep", run: () => sweepOrphanedImapCache(env, now) });
	}, 60_000);
	return () => clearInterval(timer);
}

import { dailyJobs, frequentJobs, runScheduledJob } from "@/lib/scheduled/jobs";
import type { ScheduledJob } from "@/lib/scheduled/jobs-types";

/** Jobs marked `everyFiveMinutes` assume the Worker cron's cadence; this loop ticks every minute. */
const FIVE_MINUTES_MS = 5 * 60_000;

/** A job still running when its next tick fires is skipped, so a slow run never overlaps itself. */
const running = new Set<string>();
async function runOnce(job: ScheduledJob) {
	if (running.has(job.name)) {
		console.warn(`Scheduled job ${job.name} skipped: its previous run is still running.`);
		return;
	}
	running.add(job.name);
	try {
		await runScheduledJob(job);
	} finally {
		running.delete(job.name);
	}
}

/** Fire the daily 02:00 UTC backup and the recurring maintenance jobs, matching the cron triggers in wrangler.jsonc. */
export function startScheduler(env: CloudflareEnv) {
	let lastRunDay = "";
	let lastSpacedRunAt = 0;
	const timer = setInterval(() => {
		const now = new Date();
		const spacedDue = now.getTime() - lastSpacedRunAt >= FIVE_MINUTES_MS;
		if (spacedDue) lastSpacedRunAt = now.getTime();
		for (const job of frequentJobs(env, now)) {
			if (!job.everyFiveMinutes || spacedDue) void runOnce(job);
		}
		const day = now.toISOString().slice(0, 10);
		if (now.getUTCHours() !== 2 || lastRunDay === day) return;
		lastRunDay = day;
		for (const job of dailyJobs(env, now)) void runOnce(job);
	}, 60_000);
	return () => clearInterval(timer);
}

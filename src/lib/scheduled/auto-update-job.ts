import { runAutoUpdate } from "@/lib/update/auto-update";
import type { ScheduledJob } from "./jobs-types";

/**
 * Runs every five minutes on Workers and Vercel only. It is apart from jobs.ts because it reaches the admin
 * update route's code, which imports Next modules the self-hosted server bundle cannot load.
 */
export function autoUpdateJob(env: CloudflareEnv): ScheduledJob {
	return { name: "Auto-update", run: () => runAutoUpdate(env) };
}

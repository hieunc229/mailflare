import { timingSafeEqualText } from "@/lib/api-keys";
import { getEnv } from "@/lib/cloudflare";
import { isVercelRuntime } from "@/lib/runtime";
import { autoUpdateJob } from "@/lib/scheduled/auto-update-job";
import { dailyJobs, frequentJobs, runScheduledJob } from "@/lib/scheduled/jobs";
import type { VercelQueues } from "../../../../../../server/runtime/vercel-queue";

export const dynamic = "force-dynamic";
/** Seconds; the ceiling of a Vercel Pro function. */
export const maxDuration = 300;

const SCHEDULES = {
	frequent: (env: CloudflareEnv, now: Date) => [...frequentJobs(env, now), autoUpdateJob(env)],
	daily: dailyJobs,
};

/** Vercel Cron (vercel.json) and the five-minute queue message call this with `Authorization: Bearer $CRON_SECRET`. 404 on every other runtime. */
export async function GET(request: Request, { params }: { params: Promise<{ schedule: string }> }) {
	if (!isVercelRuntime()) return new Response("Not found", { status: 404 });
	const { schedule } = await params;
	if (schedule !== "frequent" && schedule !== "daily") return new Response("Not found", { status: 404 });
	const env = getEnv();
	const secret = (env as unknown as { CRON_SECRET?: string }).CRON_SECRET?.trim();
	if (!secret || !timingSafeEqualText(request.headers.get("authorization") ?? "", `Bearer ${secret}`)) {
		return Response.json({ error: "Unauthorized" }, { status: 401 });
	}
	// With Vercel Queues, this asks for the next five-minute run (before the jobs, so a slow one cannot stop it).
	await (env as unknown as { VERCEL_QUEUES?: VercelQueues }).VERCEL_QUEUES?.ensureTick();
	const jobs = SCHEDULES[schedule](env, new Date());
	const results = await Promise.all(jobs.map(runScheduledJob));
	const failed = jobs.filter((_job, index) => !results[index]).map((job) => job.name);
	return Response.json({ ran: jobs.length, failed }, { status: failed.length ? 500 : 200 });
}

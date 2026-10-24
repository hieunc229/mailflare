import type { ImportJobSummary } from "@/lib/import/jobs-types";

export const IMPORT_JOBS_POLL_MS = 2000;

export function isImportJobActive(job: Pick<ImportJobSummary, "status">): boolean {
	return job.status === "queued" || job.status === "running";
}

/** Whole percent, or null while the job does not know its size yet. */
export function getImportJobPercent(job: Pick<ImportJobSummary, "status" | "total" | "processed">): number | null {
	if (job.status === "completed") return 100;
	if (job.total <= 0) return null;
	return Math.min(100, Math.floor((job.processed / job.total) * 100));
}

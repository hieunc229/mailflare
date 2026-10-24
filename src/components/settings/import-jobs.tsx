"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useLanguage } from "@/components/language-provider";
import { Button } from "@/components/ui/button";
import type { ImportJobSummary } from "@/lib/import/jobs-types";
import { fetchImportJobs, removeImportJob } from "@/app/(settings)/settings/import/utils";
import { getImportJobPercent, IMPORT_JOBS_POLL_MS, isImportJobActive } from "./import-jobs-utils";

const STATUS_STYLE: Record<ImportJobSummary["status"], string> = {
	queued: "bg-neutral-100 text-neutral-600",
	running: "bg-blue-50 text-blue-700",
	completed: "bg-green-50 text-green-700",
	failed: "bg-red-50 text-red-700",
	cancelled: "bg-amber-50 text-amber-700",
};

/** Imports run on the server; this lists them and follows the ones still working. `refreshKey` forces a reload. */
export function ImportJobs({ refreshKey }: { refreshKey: number }) {
	const { t } = useLanguage();
	const [jobs, setJobs] = useState<ImportJobSummary[]>([]);
	const [loaded, setLoaded] = useState(false);
	const previous = useRef<Map<string, ImportJobSummary["status"]>>(new Map());

	const load = useCallback(async () => {
		try {
			const next = await fetchImportJobs();
			const finishedNow = next.some((job) => {
				const before = previous.current.get(job.id);
				return !!before && (before === "queued" || before === "running") && !isImportJobActive(job);
			});
			previous.current = new Map(next.map((job) => [job.id, job.status]));
			setJobs(next);
			if (finishedNow) window.dispatchEvent(new Event("mailflare:messages-changed"));
		} catch {
			// Keep the last list; the next poll retries.
		} finally {
			setLoaded(true);
		}
	}, []);

	const hasActive = jobs.some(isImportJobActive);

	useEffect(() => {
		void load();
	}, [load, refreshKey]);

	useEffect(() => {
		if (!hasActive) return;
		const timer = setInterval(() => void load(), IMPORT_JOBS_POLL_MS);
		return () => clearInterval(timer);
	}, [hasActive, load]);

	async function onRemove(job: ImportJobSummary) {
		try {
			await removeImportJob(job.id);
		} finally {
			await load();
		}
	}

	if (loaded && jobs.length === 0) return null;

	return (
		<section className="space-y-4" aria-live="polite">
			<div>
				<h2 className="text-xl font-semibold text-neutral-900">{t("importJobs.title")}</h2>
				<p className="mt-1 text-sm text-neutral-500">{t("importJobs.description")}</p>
			</div>
			<ul className="space-y-3">
				{jobs.map((job) => {
					const percent = getImportJobPercent(job);
					const active = isImportJobActive(job);
					return (
						<li key={job.id} className="space-y-3 rounded-2xl bg-white p-4">
							<div className="flex items-start justify-between gap-3">
								<div className="min-w-0">
									<p className="truncate text-sm font-medium text-neutral-900">{job.label}</p>
									<p className="text-xs text-neutral-500">
										{job.kind === "imap" ? t("importPage.imap") : t("importPage.backupFile")} ·{" "}
										{new Date(job.createdAt).toLocaleString()}
									</p>
								</div>
								<div className="flex shrink-0 items-center gap-2">
									<span className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_STYLE[job.status]}`}>
										{t(`importJobs.status.${job.status}`)}
									</span>
									<Button type="button" variant="outline" size="sm" onClick={() => void onRemove(job)}>
										{active ? t("importJobs.cancel") : t("importJobs.dismiss")}
									</Button>
								</div>
							</div>
							{active && (
								<div className="space-y-1 text-xs text-neutral-500">
									<div className="flex justify-between gap-3">
										<span className="truncate">
											{job.currentSource
												? t("importPage.importingSource", { source: job.currentSource })
												: job.status === "queued"
													? t("importJobs.waiting")
													: t("importPage.importingMessages")}
										</span>
										<span>{percent === null ? "…" : `${percent}%`}</span>
									</div>
									<div className="h-1.5 overflow-hidden rounded-full bg-neutral-100">
										<div
											className={`h-full bg-blue-600 transition-[width] ${percent === null ? "w-1/3 animate-pulse" : ""}`}
											style={percent === null ? undefined : { width: `${percent}%` }}
										/>
									</div>
								</div>
							)}
							<p className="text-xs text-neutral-500">
								{t("importJobs.counts", {
									processed: job.processed,
									total: job.total,
									imported: job.imported,
									skipped: job.skipped,
								})}
							</p>
							{job.error && (
								<p className="rounded-lg border border-red-100 bg-red-50 px-3 py-2 text-xs text-red-700">{job.error}</p>
							)}
							{job.errorCount > 0 && (
								<details className="text-xs text-neutral-600">
									<summary className="cursor-pointer">{t("importJobs.errors", { count: job.errorCount })}</summary>
									<ul className="mt-2 list-disc space-y-1 pl-5">
										{job.errors.slice(0, 5).map((item) => (
											<li key={item}>{item}</li>
										))}
									</ul>
								</details>
							)}
						</li>
					);
				})}
			</ul>
		</section>
	);
}

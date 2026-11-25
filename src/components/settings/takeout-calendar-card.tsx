"use client";

import clsx from "clsx";
import type { FormEvent, KeyboardEvent } from "react";
import { useEffect, useRef, useState } from "react";
import { Upload } from "@/components/icons";
import { useLanguage } from "@/components/language-provider";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { authFetch } from "@/lib/auth/client";
import { isIcsAddress } from "@/lib/calendar/ics";
import { FOLDER_COLOR_OPTIONS, FOLDER_COLOR_VALUES } from "@/lib/folders/colors";
import { folderColorKeys } from "@/lib/folders/color-keys";
import { importCalendarBytes, parseRetryAfter, previewCalendarBytes } from "@/lib/import/takeout-calendar-utils";
import type { CalendarPost, CalendarPostResult } from "@/lib/import/takeout-calendar-types";
import { readTakeoutSource } from "@/lib/import/takeout-data-utils";
import { getUserTimeZone } from "@/lib/time/utils";
import { radioTarget, resultTone } from "./takeout-calendar-card-utils";
import type { CalendarRowState, CalendarRunProgress, CalendarRunResult, TakeoutCalendarCardProps } from "./takeout-calendar-card-types";

const post: CalendarPost = async (body, signal) => {
	const response = await authFetch("/api/import/calendar", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal });
	return { status: response.status, retryAfterMs: parseRetryAfter(response.headers.get("Retry-After")), data: (await response.json().catch(() => ({ error: `HTTP ${response.status}` }))) as CalendarPostResult["data"] };
};

const TONE_CLASSES = {
	success: "border-green-100 bg-green-50 text-green-800",
	partial: "border-amber-200 bg-amber-50 text-amber-900",
	failed: "border-red-200 bg-red-50 text-red-800",
};

/** The calendars found in the picked files: one row each, with options, Import, Preview and the results. */
export function TakeoutCalendarCard({ sources }: TakeoutCalendarCardProps) {
	const { t } = useLanguage();
	// The parent remounts this card for every scan, so the defaults are only needed once: the colors cycle and a file
	// named after a Google address prefills it.
	const [rows, setRows] = useState<Record<string, CalendarRowState>>(() => Object.fromEntries(sources.map((source, index) => [source.id, {
		included: true,
		color: FOLDER_COLOR_VALUES[index % FOLDER_COLOR_VALUES.length],
		googleAddress: isIcsAddress(source.label) ? source.label : "",
	}])));
	const [reminders, setReminders] = useState(true);
	const [skipDeclined, setSkipDeclined] = useState(true);
	const [progress, setProgress] = useState<CalendarRunProgress | null>(null);
	const [results, setResults] = useState<CalendarRunResult[]>([]);
	const [error, setError] = useState<string | null>(null);
	// What a screen reader hears: one message when each calendar starts and one when the run ends, not every batch.
	const [announce, setAnnounce] = useState("");
	const controllerRef = useRef<AbortController | null>(null);
	const running = progress !== null;

	useEffect(() => {
		if (!running) return;
		const onBeforeUnload = (event: BeforeUnloadEvent) => event.preventDefault();
		window.addEventListener("beforeunload", onBeforeUnload);
		return () => window.removeEventListener("beforeunload", onBeforeUnload);
	}, [running]);

	// Leaving the page stops the loop; running it again skips what was imported.
	useEffect(() => () => controllerRef.current?.abort(), []);

	const update = (id: string, patch: Partial<CalendarRowState>) => setRows((current) => ({ ...current, [id]: { ...current[id], ...patch } }));
	const chosen = sources.filter((source) => rows[source.id]?.included);

	// Arrow keys, Home and End move the selection inside a color group, as a native radio group does.
	function onColorKeys(event: KeyboardEvent<HTMLDivElement>, id: string) {
		const radios = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("[role=radio]")];
		const index = radios.indexOf(event.target as HTMLButtonElement);
		const next = index < 0 ? null : radioTarget(event.key, index, radios.length);
		if (next === null) return;
		event.preventDefault();
		radios[next].focus();
		update(id, { color: FOLDER_COLOR_OPTIONS[next].value });
	}

	async function start(mode: "import" | "preview") {
		if (chosen.length === 0 || running) return;
		setError(null);
		setResults([]);
		const controller = new AbortController();
		controllerRef.current = controller;
		const collected: CalendarRunResult[] = [];
		let failed = false;
		try {
			for (const [index, source] of chosen.entries()) {
				const row = rows[source.id];
				const base = { mode, label: source.label, index: index + 1, count: chosen.length, done: 0, total: 0 };
				setProgress(base);
				setAnnounce(t("importPage.takeoutReading", { source: source.label, index: index + 1, count: chosen.length }));
				const bytes = await readTakeoutSource(source);
				const settings = { name: source.label.slice(0, 120), color: row.color, googleAddress: row.googleAddress.trim(), reminders, skipDeclined };
				const onProgress = (done: number, total: number) => setProgress({ ...base, done, total });
				const summary = mode === "import"
					? await importCalendarBytes(bytes, settings, { post, signal: controller.signal, onProgress })
					: await previewCalendarBytes(bytes, settings, getUserTimeZone(), { signal: controller.signal, onProgress });
				collected.push({ id: source.id, label: source.label, mode, summary });
				setResults([...collected]);
				if (summary.aborted || summary.rateLimited) break;
			}
		} catch (caught) {
			failed = true;
			if (!controller.signal.aborted) setError(caught instanceof Error ? caught.message : String(caught));
		} finally {
			// A failure is announced by the alert below.
			setAnnounce(failed && !controller.signal.aborted ? "" : t(controller.signal.aborted || collected.some((item) => item.summary.aborted) ? "importPage.takeoutStopped" : collected.some((item) => item.summary.rateLimited) ? "importPage.takeoutDataRateLimited" : "importPage.takeoutDataFinished"));
			controllerRef.current = null;
			setProgress(null);
		}
	}

	function onSubmit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		void start("import");
	}

	const percent = progress && progress.total > 0 ? Math.min(100, Math.round((progress.done / progress.total) * 100)) : 0;

	return (
		<form onSubmit={onSubmit} className="space-y-4">
			<fieldset className="space-y-2" disabled={running}>
				<legend className="text-sm font-medium text-neutral-900">{t("importPage.takeoutDataCalendars")}</legend>
				<ul className="divide-y divide-neutral-100 rounded-lg border border-neutral-200">
					{sources.map((source) => {
						const row = rows[source.id];
						if (!row) return null;
						return (
							<li key={source.id} className="grid gap-3 p-3 md:grid-cols-[minmax(0,1fr)_minmax(0,16rem)] md:items-center">
								<div className="space-y-2">
									<label className="flex min-h-8 items-center gap-2 text-sm font-medium text-neutral-900">
										<Checkbox checked={row.included} onChange={(event) => update(source.id, { included: event.target.checked })} />
										<span className="break-all">{source.label}</span>
									</label>
									<div role="radiogroup" aria-label={t("importPage.takeoutDataColorFor", { name: source.label })} onKeyDown={(event) => onColorKeys(event, source.id)} className="flex flex-wrap items-center gap-1.5 pl-6">
										{FOLDER_COLOR_OPTIONS.map((option) => (
											<button
												key={option.value}
												type="button"
												role="radio"
												aria-label={t(folderColorKeys[option.value])}
												title={t(folderColorKeys[option.value])}
												aria-checked={row.color === option.value}
												tabIndex={row.color === option.value ? 0 : -1}
												onClick={() => update(source.id, { color: option.value })}
												className={clsx("h-7 w-7 rounded-full border-2 transition-transform hover:scale-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2 motion-reduce:transition-none motion-reduce:hover:scale-100", row.color === option.value ? "border-neutral-900 ring-2 ring-neutral-300 ring-offset-2" : "border-transparent")}
												style={{ backgroundColor: option.value }}
											/>
										))}
									</div>
								</div>
								<Input
									type="email"
									value={row.googleAddress}
									onChange={(event) => update(source.id, { googleAddress: event.target.value })}
									aria-label={t("importPage.takeoutDataAddressFor", { name: source.label })}
									placeholder={t("importPage.takeoutDataAddress")}
									autoComplete="off"
								/>
							</li>
						);
					})}
				</ul>
				<p className="text-xs leading-5 text-neutral-500">{t("importPage.takeoutDataAddressHint")}</p>
			</fieldset>
			<div className="grid gap-2 sm:grid-cols-2">
				<label className="flex items-center gap-2 text-sm text-neutral-700">
					<Checkbox checked={reminders} disabled={running} onChange={(event) => setReminders(event.target.checked)} />
					{t("importPage.takeoutDataReminders")}
				</label>
				<label className="flex items-center gap-2 text-sm text-neutral-700">
					<Checkbox checked={skipDeclined} disabled={running} onChange={(event) => setSkipDeclined(event.target.checked)} />
					{t("importPage.takeoutDataSkipDeclined")}
				</label>
			</div>
			<p className="rounded-lg border border-neutral-200 bg-neutral-50 px-4 py-3 text-xs leading-5 text-neutral-500">{t("importPage.takeoutKeepOpen")}</p>
			<div className="flex flex-wrap gap-2">
				<Button type="submit" disabled={chosen.length === 0 || running}>
					<Upload className="h-4 w-4" />
					{progress?.mode === "import" ? t("import.importing") : t("importPage.takeoutStart")}
				</Button>
				<Button type="button" variant="outline" disabled={chosen.length === 0 || running} onClick={() => void start("preview")}>
					{t("importPage.takeoutPreview")}
				</Button>
				{running && (
					<Button type="button" variant="outline" onClick={() => controllerRef.current?.abort()}>
						{t("importPage.takeoutStop")}
					</Button>
				)}
			</div>
			<p className="sr-only" role="status">{announce}</p>
				{progress && (
				<div className="space-y-1 text-xs text-neutral-500">
					<div className="flex justify-between gap-4">
						<span className="truncate">{t("importPage.takeoutReading", { source: progress.label, index: progress.index, count: progress.count })}</span>
						<span className="shrink-0">{t("importPage.takeoutDataProgress", { done: progress.done, total: progress.total })}</span>
					</div>
					<div className="h-1.5 overflow-hidden rounded-full bg-neutral-100" role="progressbar" aria-label={t("importPage.takeoutReading", { source: progress.label, index: progress.index, count: progress.count })} aria-valuetext={t("importPage.takeoutDataProgress", { done: progress.done, total: progress.total })} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}>
						<div className="h-full bg-blue-600 transition-[width] motion-reduce:transition-none" style={{ width: `${percent}%` }} />
					</div>
				</div>
			)}
			{results.length > 0 && (
				<div className={clsx("space-y-3 rounded-lg border px-4 py-3 text-sm", TONE_CLASSES[resultTone(results)])}>
					{results.map(({ id, label, mode, summary }) => (
						<div key={id} className="space-y-1">
							<p className="break-all font-medium">{label}</p>
							{summary.aborted && <p className="text-xs">{t("importPage.takeoutStopped")}</p>}
							{summary.rateLimited && <p className="text-xs font-medium">{t("importPage.takeoutDataRateLimited")}</p>}
							<p>{mode === "import"
								? t("importPage.takeoutDataCounts", { imported: summary.imported, skipped: summary.skipped })
								: t("importPage.takeoutDataPreviewResult", { events: summary.events, series: summary.series })}</p>
							{summary.simplified > 0 && <p className="text-xs">{t("importPage.takeoutDataSimplified", { count: summary.simplified })}</p>}
							{summary.guessedZone > 0 && <p className="text-xs">{t("importPage.takeoutDataGuessedZone", { count: summary.guessedZone })}</p>}
							{summary.failed > 0 && (
								<div className="text-xs font-medium">
									<p>{t("importPage.takeoutDataFailed", { count: summary.failed })}</p>
									<ul className="mt-1 list-disc space-y-0.5 pl-5">
										{summary.errors.map((item, index) => <li key={`${index}-${item}`} className="break-words">{item}</li>)}
									</ul>
								</div>
							)}
						</div>
					))}
				</div>
			)}
			{error && <p role="alert" className="rounded-lg border border-red-100 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</p>}
		</form>
	);
}

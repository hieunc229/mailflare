"use client";

import type { FormEvent } from "react";
import { useEffect, useRef, useState } from "react";
import { Upload } from "lucide-react";
import { useLanguage } from "@/components/language-provider";
import { useSelectedMailbox } from "@/components/mailbox-provider";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { TranslationKey } from "@/lib/i18n/types";
import type { TakeoutImportSummary } from "@/lib/import/gmail-takeout-types";
import { parseIgnoredLabels, runTakeoutImport, splitMbox } from "@/lib/import/gmail-takeout-utils";
import { isZipSupported, readStreamChunks } from "@/lib/import/zip-utils";
import type { TakeoutRunState } from "./takeout-import-types";
import {
	addTakeoutSummaries,
	clearTakeoutProgress,
	createTakeoutFolderResolver,
	createTakeoutUploader,
	emptyTakeoutSummary,
	formatBytes,
	getTakeoutProgress,
	getTakeoutSources,
	saveTakeoutProgress,
} from "./takeout-import-utils";

const SECTION_LABEL_KEYS: Record<string, TranslationKey> = {
	inbox: "navigation.inbox",
	sent: "navigation.sent",
	drafts: "navigation.drafts",
	archived: "navigation.archived",
	spam: "navigation.spam",
	trash: "navigation.trash",
};

function cloneSummary(summary: TakeoutImportSummary): TakeoutImportSummary {
	return { ...summary, errors: [...summary.errors], destinations: { ...summary.destinations } };
}

/** Imports a Google Takeout export: the zip is read in the browser and messages are uploaded in batches. */
export function TakeoutImport() {
	const { t } = useLanguage();
	const { selectedMailbox } = useSelectedMailbox();
	const [files, setFiles] = useState<File[]>([]);
	const [folders, setFolders] = useState(true);
	const [skipSpam, setSkipSpam] = useState(false);
	const [skipTrash, setSkipTrash] = useState(false);
	const [ignoreLabels, setIgnoreLabels] = useState("");
	const [run, setRun] = useState<TakeoutRunState | null>(null);
	const [result, setResult] = useState<{ mode: TakeoutRunState["mode"]; summary: TakeoutImportSummary } | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [notice, setNotice] = useState<string | null>(null);
	const controllerRef = useRef<AbortController | null>(null);
	const liveRef = useRef<TakeoutRunState | null>(null);
	const running = run !== null;

	useEffect(() => {
		if (!running) return;
		const timer = window.setInterval(() => {
			if (liveRef.current) setRun({ ...liveRef.current, summary: cloneSummary(liveRef.current.summary) });
		}, 500);
		const onBeforeUnload = (event: BeforeUnloadEvent) => {
			if (liveRef.current?.mode === "import") event.preventDefault();
		};
		window.addEventListener("beforeunload", onBeforeUnload);
		return () => {
			window.clearInterval(timer);
			window.removeEventListener("beforeunload", onBeforeUnload);
		};
	}, [running]);

	function destinationLabel(key: string): string {
		const [type, ...rest] = key.split(":");
		const value = rest.join(":");
		if (type === "folder") return t("importPage.takeoutFolder", { name: value });
		return SECTION_LABEL_KEYS[value] ? t(SECTION_LABEL_KEYS[value]) : value;
	}

	async function start(mode: TakeoutRunState["mode"]) {
		const mailboxId = selectedMailbox?.id;
		if (!mailboxId || files.length === 0) return;
		setError(null);
		setNotice(null);
		setResult(null);
		if (!isZipSupported() && files.some((file) => /\.zip$/i.test(file.name))) {
			setError(t("importPage.takeoutUnsupported"));
			return;
		}
		const controller = new AbortController();
		controllerRef.current = controller;
		let total = emptyTakeoutSummary();
		const initial: TakeoutRunState = { mode, sourceIndex: 0, sourceCount: 0, sourceLabel: "", bytesRead: 0, bytesTotal: 0, resumedAt: 0, summary: total };
		liveRef.current = initial;
		setRun(initial);
		try {
			const { sources, withoutMbox } = await getTakeoutSources(files);
			if (withoutMbox.length > 0) setNotice(t("importPage.takeoutNoMbox", { files: withoutMbox.join(", ") }));
			if (sources.length === 0) return;
			const upload = createTakeoutUploader(mailboxId);
			const resolveFolder = createTakeoutFolderResolver(mailboxId);
			for (const [index, source] of sources.entries()) {
				const resumedAt = mode === "import" ? getTakeoutProgress(mailboxId, source) : 0;
				const live: TakeoutRunState = {
					mode,
					sourceIndex: index + 1,
					sourceCount: sources.length,
					sourceLabel: source.label,
					bytesRead: 0,
					bytesTotal: source.size,
					resumedAt,
					summary: total,
				};
				liveRef.current = live;
				const before = total;
				const chunks = readStreamChunks(await source.open(), (bytes) => {
					live.bytesRead += bytes;
				});
				const summary = await runTakeoutImport(splitMbox(chunks), {
					labels: { folders, ignore: parseIgnoredLabels(ignoreLabels) },
					skipSpam,
					skipTrash,
					startAt: resumedAt,
					dryRun: mode === "preview",
					signal: controller.signal,
					upload,
					resolveFolder,
					onProgress: (progress) => {
						live.summary = addTakeoutSummaries(before, progress);
						if (mode === "import") saveTakeoutProgress(mailboxId, source, progress.committed);
					},
				});
				total = addTakeoutSummaries(before, summary);
				if (summary.aborted) break;
				if (mode === "import") clearTakeoutProgress(mailboxId, source);
			}
			setResult({ mode, summary: total });
		} catch (caught) {
			setError(caught instanceof Error ? caught.message : String(caught));
		} finally {
			controllerRef.current = null;
			liveRef.current = null;
			setRun(null);
			if (mode === "import") window.dispatchEvent(new Event("mailflare:messages-changed"));
		}
	}

	function onSubmit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		void start("import");
	}

	const summary = run?.summary ?? result?.summary ?? null;
	const percent = run && run.bytesTotal > 0 ? Math.min(100, Math.round((run.bytesRead / run.bytesTotal) * 100)) : 0;
	const destinations = Object.entries(result?.summary.destinations ?? {}).sort((a, b) => b[1] - a[1]);
	const destinationCount = destinations.reduce((sum, [, count]) => sum + count, 0);

	return (
		<form onSubmit={onSubmit} className="space-y-4">
			<div className="space-y-2">
				<Label htmlFor="takeout-files">{t("importPage.takeoutFiles")}</Label>
				<Input
					id="takeout-files"
					type="file"
					accept=".zip,.mbox,application/zip,application/mbox"
					multiple
					disabled={running}
					onChange={(event) => setFiles(Array.from(event.target.files ?? []))}
					className="block w-full rounded-md border border-neutral-200 bg-white px-3 py-1 text-sm shadow-sm shadow-neutral-200/50 file:mr-3 file:rounded-md file:border-0 file:bg-neutral-100 file:px-3 file:py-1.5 file:text-sm file:font-medium"
				/>
				<p className="text-xs leading-5 text-neutral-500">{t("importPage.takeoutHint")}</p>
			</div>
			<div className="grid gap-2 sm:grid-cols-3">
				<label className="flex items-center gap-2 text-sm text-neutral-700">
					<Checkbox checked={folders} disabled={running} onChange={(event) => setFolders(event.target.checked)} />
					{t("importPage.takeoutFolders")}
				</label>
				<label className="flex items-center gap-2 text-sm text-neutral-700">
					<Checkbox checked={skipSpam} disabled={running} onChange={(event) => setSkipSpam(event.target.checked)} />
					{t("importPage.takeoutSkipSpam")}
				</label>
				<label className="flex items-center gap-2 text-sm text-neutral-700">
					<Checkbox checked={skipTrash} disabled={running} onChange={(event) => setSkipTrash(event.target.checked)} />
					{t("importPage.takeoutSkipTrash")}
				</label>
			</div>
			{folders && (
				<div className="space-y-2">
					<Label htmlFor="takeout-ignore">{t("importPage.takeoutIgnoreLabels")}</Label>
					<Input
						id="takeout-ignore"
						value={ignoreLabels}
						disabled={running}
						onChange={(event) => setIgnoreLabels(event.target.value)}
						placeholder="[Superhuman]/, Notes"
					/>
					<p className="text-xs leading-5 text-neutral-500">{t("importPage.takeoutIgnoreHint")}</p>
				</div>
			)}
			<p className="rounded-lg border border-neutral-200 bg-neutral-50 px-4 py-3 text-xs leading-5 text-neutral-500">
				{t("importPage.takeoutKeepOpen")}
			</p>
			<div className="flex flex-wrap gap-2">
				<Button type="submit" disabled={!selectedMailbox || files.length === 0 || running}>
					<Upload className="h-4 w-4" />
					{run?.mode === "import" ? t("import.importing") : t("importPage.takeoutStart")}
				</Button>
				<Button type="button" variant="outline" disabled={!selectedMailbox || files.length === 0 || running} onClick={() => void start("preview")}>
					{t("importPage.takeoutPreview")}
				</Button>
				{running && (
					<Button type="button" variant="outline" onClick={() => controllerRef.current?.abort()}>
						{t("importPage.takeoutStop")}
					</Button>
				)}
			</div>
			{run && (
				<div className="space-y-1 text-xs text-neutral-500" aria-live="polite">
					<div className="flex justify-between gap-4">
						<span className="truncate">
							{run.sourceCount > 0
								? t("importPage.takeoutReading", { source: run.sourceLabel, index: run.sourceIndex, count: run.sourceCount })
								: t("importPage.preparing")}
						</span>
						<span className="shrink-0">
							{formatBytes(run.bytesRead)} / {formatBytes(run.bytesTotal)}
						</span>
					</div>
					<div className="h-1.5 overflow-hidden rounded-full bg-neutral-100">
						<div className="h-full bg-blue-600 transition-[width]" style={{ width: `${percent}%` }} />
					</div>
					{run.resumedAt > 0 && <p>{t("importPage.takeoutResumed", { count: run.resumedAt })}</p>}
				</div>
			)}
			{summary && (run?.mode === "import" || result?.mode === "import") && (
				<p className="text-sm text-neutral-700">
					{t("importPage.takeoutCounts", { read: summary.read, imported: summary.imported, skipped: summary.skipped })}
				</p>
			)}
			{result && (
				<div className="space-y-2 rounded-lg border border-green-100 bg-green-50 px-4 py-3 text-sm text-green-800">
					{result.summary.aborted && <p className="font-medium">{t("importPage.takeoutStopped")}</p>}
					{result.mode === "preview" && (
						<>
							<p className="font-medium">{t("importPage.takeoutPreviewResult", { count: destinationCount })}</p>
							<ul className="space-y-0.5 text-xs">
								{destinations.map(([key, count]) => (
									<li key={key} className="flex justify-between gap-4">
										<span className="truncate">{destinationLabel(key)}</span>
										<span className="tabular-nums">{count}</span>
									</li>
								))}
							</ul>
						</>
					)}
					{result.summary.tooLarge > 0 && <p className="text-xs">{t("importPage.takeoutTooLarge", { count: result.summary.tooLarge })}</p>}
					{result.summary.ignored > 0 && <p className="text-xs">{t("importPage.takeoutIgnored", { count: result.summary.ignored })}</p>}
					{result.summary.failed > 0 && (
						<div className="text-xs text-red-700">
							<p>{t("importPage.takeoutFailed", { count: result.summary.failed })}</p>
							<ul className="mt-1 list-disc space-y-0.5 pl-5">
								{result.summary.errors.slice(0, 5).map((item) => (
									<li key={item}>{item}</li>
								))}
							</ul>
						</div>
					)}
				</div>
			)}
			{notice && <p className="rounded-lg border border-amber-100 bg-amber-50 px-4 py-3 text-sm text-amber-700">{notice}</p>}
			{error && <p className="rounded-lg border border-red-100 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</p>}
		</form>
	);
}

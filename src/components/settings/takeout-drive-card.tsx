"use client";

import clsx from "clsx";
import type { FormEvent } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { uploadDriveSource } from "@/app/(drive)/drive-upload";
import { Upload } from "@/components/icons";
import { useLanguage } from "@/components/language-provider";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { authFetch } from "@/lib/auth/client";
import { formatDriveSize } from "@/lib/drive/utils";
import { parseRetryAfter } from "@/lib/import/takeout-calendar-utils";
import { importDriveFiles, MAX_CONSECUTIVE_FAILURES } from "@/lib/import/takeout-drive-utils";
import type { DrivePostResult, DriveRunProgress, DriveRunSummary } from "@/lib/import/takeout-drive-types";
import { canStartDrive, defaultDriveRoot, driveTone, folderOptions, freeStorage, isLargeImport, newFolderName, topFolders } from "./takeout-drive-card-utils";
import type { DriveStorage, TakeoutDriveCardProps } from "./takeout-drive-card-types";

const post = async (path: "/api/drive/import/folders" | "/api/drive/import/files", body: unknown, signal?: AbortSignal): Promise<DrivePostResult> => {
	const response = await authFetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal });
	return { status: response.status, data: (await response.json().catch(() => ({ error: `HTTP ${response.status}` }))) as DrivePostResult["data"], retryAfterMs: parseRetryAfter(response.headers.get("Retry-After")) };
};

const TONE_CLASSES = {
	success: "border-green-100 bg-green-50 text-green-800",
	partial: "border-amber-200 bg-amber-50 text-amber-900",
	failed: "border-red-200 bg-red-50 text-red-800",
};

/** The Drive files found in the picked zips: which folder to take, where to put it, Import, Stop and the results. */
export function TakeoutDriveCard({ drive }: TakeoutDriveCardProps) {
	const { t } = useLanguage();
	// The parent remounts this card for every scan, so the defaults are only needed once.
	const [rootKey, setRootKey] = useState(() => defaultDriveRoot(drive.roots));
	// Of a large import: only the files below this folder at the top of the Takeout folder ("" is all of it).
	const [only, setOnly] = useState("");
	const [into, setInto] = useState("new");
	const [folders, setFolders] = useState<{ id: string; label: string }[]>([]);
	const [storage, setStorage] = useState<DriveStorage | null>(null);
	const [progress, setProgress] = useState<DriveRunProgress | null>(null);
	const [summary, setSummary] = useState<DriveRunSummary | null>(null);
	const [error, setError] = useState<string | null>(null);
	// What a screen reader hears: one message when the run starts and one when it ends, not every file.
	const [announce, setAnnounce] = useState("");
	const controllerRef = useRef<AbortController | null>(null);
	const startRef = useRef<HTMLButtonElement>(null);
	const stopRef = useRef<HTMLButtonElement>(null);
	const wasRunning = useRef(false);
	const running = progress !== null;
	const todayName = useMemo(() => newFolderName(new Date()), []);

	useEffect(() => {
		let current = true;
		void (async () => {
			try {
				const [items, list] = await Promise.all([authFetch("/api/drive/items"), authFetch("/api/drive/folders")]);
				if (!current) return;
				if (items.ok) {
					const data = (await items.json()) as { storageUsed?: number; storageLimit?: number | null };
					if (current) setStorage({ used: data.storageUsed, limit: data.storageLimit ?? null });
				}
				if (list.ok) {
					const data = (await list.json()) as { folders?: { id: string; name: string; parentId: string | null }[] };
					if (current) setFolders(folderOptions(data.folders ?? []));
				}
			} catch { /* The card works without them: the server still enforces the limit. */ }
		})();
		return () => { current = false; };
	}, []);

	useEffect(() => {
		if (!running) return;
		const onBeforeUnload = (event: BeforeUnloadEvent) => event.preventDefault();
		window.addEventListener("beforeunload", onBeforeUnload);
		return () => window.removeEventListener("beforeunload", onBeforeUnload);
	}, [running]);

	// The button that was pressed turns off while the import runs, so keyboard focus moves to Stop and comes back to Import afterwards.
	useEffect(() => {
		if (running) stopRef.current?.focus();
		else if (wasRunning.current) startRef.current?.focus();
		wasRunning.current = running;
	}, [running]);

	// Leaving the page stops the loop; running it again skips what is already in Drive.
	useEffect(() => () => controllerRef.current?.abort(), []);

	const chosenRoot = drive.roots.find((root) => root.key === rootKey);
	const rootFiles = useMemo(() => drive.files.filter((file) => file.rootKey === rootKey), [drive.files, rootKey]);
	const folderChoices = useMemo(() => topFolders(rootFiles), [rootFiles]);
	const files = useMemo(() => (only ? rootFiles.filter((file) => file.segments.length > 1 && file.segments[0] === only) : rootFiles), [rootFiles, only]);
	const dirs = useMemo(() => drive.dirs.filter((dir) => dir.rootKey === rootKey && (!only || dir.segments[0] === only)), [drive.dirs, rootKey, only]);
	const bytes = useMemo(() => files.reduce((total, file) => total + file.size, 0), [files]);
	const free = freeStorage(storage?.used, storage?.limit);
	const unusable = drive.rejectedCount + drive.skipped.symlinks + drive.skipped.encrypted;
	const canStart = canStartDrive(files.length, running, chosenRoot);

	async function start() {
		if (!canStart) return;
		setError(null);
		setSummary(null);
		const controller = new AbortController();
		controllerRef.current = controller;
		setProgress({ done: 0, total: files.length, current: "", percent: 0 });
		setAnnounce(t("importPage.takeoutDriveStarted", { total: files.length }));
		let failed = false;
		let result: DriveRunSummary | null = null;
		try {
			result = await importDriveFiles(files, dirs, { parentId: into === "new" || into === "root" ? null : into, newFolderName: into === "new" ? todayName : null }, { post, upload: uploadDriveSource, signal: controller.signal, onProgress: setProgress });
			setSummary(result);
		} catch (caught) {
			failed = true;
			if (!controller.signal.aborted) setError(caught instanceof Error ? caught.message : String(caught));
		} finally {
			// A failure is announced by the alert below.
			setAnnounce(failed && !controller.signal.aborted ? "" : t(result?.storageFull ? "importPage.takeoutDriveStorageFull" : result?.stoppedAfterFailures ? "importPage.takeoutDriveFailuresStopped" : controller.signal.aborted || result?.aborted ? "importPage.takeoutStopped" : "importPage.takeoutDataFinished", { count: MAX_CONSECUTIVE_FAILURES }));
			controllerRef.current = null;
			setProgress(null);
		}
	}

	function onSubmit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		void start();
	}

	const fraction = progress && progress.total > 0 ? (progress.done + progress.percent / 100) / progress.total : 0;
	const percent = Math.min(100, Math.round(fraction * 100));
	const progressText = progress ? t("importPage.takeoutDriveProgress", { done: progress.done, total: progress.total }) : "";

	return (
		<form onSubmit={onSubmit} className="space-y-4">
			<fieldset className="space-y-3" disabled={running}>
				<legend className="text-sm font-medium text-neutral-900">{t("importPage.takeoutDataDrive")}</legend>
				{drive.roots.length > 1 && (
					<div className="space-y-1">
						<Label htmlFor="takeout-drive-root">{t("importPage.takeoutDriveRoot")}</Label>
						<Select id="takeout-drive-root" value={rootKey} onChange={(event) => { setRootKey(event.target.value); setOnly(""); }} className="w-full py-2 text-sm">
							<option value="">{t("importPage.takeoutDriveRootChoose")}</option>
							{drive.roots.map((root) => <option key={root.key} value={root.key}>{t("importPage.takeoutDriveRootOption", { name: root.label, files: root.files, size: formatDriveSize(root.bytes) })}</option>)}
						</Select>
					</div>
				)}
				{rootKey !== "" && isLargeImport(rootFiles.length) && folderChoices.length > 1 && (
					<div className="space-y-1">
						<Label htmlFor="takeout-drive-only">{t("importPage.takeoutDriveOnly")}</Label>
						<Select id="takeout-drive-only" value={only} onChange={(event) => setOnly(event.target.value)} className="w-full py-2 text-sm">
							<option value="">{t("importPage.takeoutDriveOnlyAll")}</option>
							{folderChoices.map((folder) => <option key={folder.name} value={folder.name}>{t("importPage.takeoutDriveOnlyOption", { name: folder.name, files: folder.files })}</option>)}
						</Select>
					</div>
				)}
				{rootKey !== "" && <p className="text-sm text-neutral-700">{t("importPage.takeoutDriveFiles", { files: files.length, size: formatDriveSize(bytes) })}</p>}
				{rootKey !== "" && isLargeImport(files.length) && <p role="status" className="rounded-lg border border-amber-100 bg-amber-50 px-4 py-3 text-sm text-amber-700">{t("importPage.takeoutDriveLarge", { count: files.length })}</p>}
				<div className="space-y-1">
					<Label htmlFor="takeout-drive-into">{t("importPage.takeoutDriveInto")}</Label>
					<Select id="takeout-drive-into" value={into} onChange={(event) => setInto(event.target.value)} className="w-full py-2 text-sm">
						<option value="new">{t("importPage.takeoutDriveIntoNew", { name: todayName })}</option>
						<option value="root">{t("importPage.takeoutDriveIntoRoot")}</option>
						{folders.map((folder) => <option key={folder.id} value={folder.id}>{folder.label}</option>)}
					</Select>
				</div>
				{free !== null && rootKey !== "" && bytes > free && <p role="status" className="rounded-lg border border-amber-100 bg-amber-50 px-4 py-3 text-sm text-amber-700">{t("importPage.takeoutDriveStorageWarning", { size: formatDriveSize(bytes), free: formatDriveSize(free) })}</p>}
				{chosenRoot?.tooMany && <p role="status" className="rounded-lg border border-amber-100 bg-amber-50 px-4 py-3 text-sm text-amber-700">{t("importPage.takeoutDriveTooMany", { count: chosenRoot.files })}</p>}
				{unusable > 0 && <p className="text-xs leading-5 text-neutral-500">{t("importPage.takeoutDriveUnusable", { count: unusable })}</p>}
				<p className="text-xs leading-5 text-neutral-500">{t("importPage.takeoutDriveNote")}</p>
			</fieldset>
			<p className="rounded-lg border border-neutral-200 bg-neutral-50 px-4 py-3 text-xs leading-5 text-neutral-500">{t("importPage.takeoutKeepOpen")}</p>
			<div className="flex flex-wrap gap-2">
				<Button ref={startRef} type="submit" disabled={!canStart} aria-describedby={rootKey === "" ? "takeout-drive-choose" : undefined}>
					<Upload className="h-4 w-4" />
					{running ? t("import.importing") : t("importPage.takeoutStart")}
				</Button>
				{running && (
					<Button ref={stopRef} type="button" variant="outline" onClick={() => controllerRef.current?.abort()}>
						{t("importPage.takeoutStop")}
					</Button>
				)}
			</div>
			{rootKey === "" && !running && <p id="takeout-drive-choose" className="text-xs leading-5 text-neutral-500">{t("importPage.takeoutDriveChooseFirst")}</p>}
			<p className="sr-only" role="status">{announce}</p>
			{progress && (
				<div className="space-y-1 text-xs text-neutral-500">
					<div className="flex justify-between gap-4">
						<span className="truncate">{progress.current || t("importPage.takeoutDataDrive")}</span>
						<span className="shrink-0">{progressText}</span>
					</div>
					<div className="h-1.5 overflow-hidden rounded-full bg-neutral-100" role="progressbar" aria-label={t("importPage.takeoutDataDrive")} aria-valuetext={progressText} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}>
						<div className="h-full bg-blue-600 transition-[width] motion-reduce:transition-none" style={{ width: `${percent}%` }} />
					</div>
				</div>
			)}
			{summary && (
				<div className={clsx("space-y-1 rounded-lg border px-4 py-3 text-sm", TONE_CLASSES[driveTone(summary)])}>
					{summary.aborted && <p className="text-xs">{t("importPage.takeoutStopped")}</p>}
					{summary.storageFull && <p className="text-xs font-medium">{t("importPage.takeoutDriveStorageFull")}</p>}
					{summary.stoppedAfterFailures && <p className="text-xs font-medium">{t("importPage.takeoutDriveFailuresStopped", { count: MAX_CONSECUTIVE_FAILURES })}</p>}
					<p>{t("importPage.takeoutDriveCounts", { imported: summary.imported, skipped: summary.skipped, failed: summary.failed })}</p>
					{summary.tooDeep > 0 && <p className="text-xs">{t("importPage.takeoutDriveTooDeep", { count: summary.tooDeep })}</p>}
					{summary.errors.length > 0 && (
						<ul className="list-disc space-y-0.5 pl-5 text-xs font-medium">
							{summary.errors.map((item, index) => <li key={index} className="break-words">{item}</li>)}
						</ul>
					)}
				</div>
			)}
			{error && <p role="alert" className="rounded-lg border border-red-100 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</p>}
		</form>
	);
}

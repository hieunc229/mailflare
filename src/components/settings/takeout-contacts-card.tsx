"use client";

import clsx from "clsx";
import type { FormEvent } from "react";
import { useEffect, useRef, useState } from "react";
import { Upload } from "@/components/icons";
import { useLanguage } from "@/components/language-provider";
import { useSelectedMailbox } from "@/components/mailbox-provider";
import { uploadContactAvatar } from "@/components/contacts/contact-avatar-form-utils";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { useCurrentUser } from "@/hooks/use-current-user";
import { authFetch } from "@/lib/auth/client";
import { ContactsFileError, importContactsBytes, parseRetryAfter, previewContactsBytes } from "@/lib/import/takeout-contacts-utils";
import type { ContactPost, ContactPostResult } from "@/lib/import/takeout-contacts-types";
import { readTakeoutSource } from "@/lib/import/takeout-data-utils";
import { contactsTone, isAddressBookOwner } from "./takeout-contacts-card-utils";
import type { ContactRunProgress, ContactRunResult, TakeoutContactsCardProps } from "./takeout-contacts-card-types";

const post: ContactPost = async (body, signal) => {
	const response = await authFetch("/api/import/contacts", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal });
	return { status: response.status, retryAfterMs: parseRetryAfter(response.headers.get("Retry-After")), data: (await response.json().catch(() => ({ error: `HTTP ${response.status}` }))) as ContactPostResult["data"] };
};

const TONE_CLASSES = {
	success: "border-green-100 bg-green-50 text-green-800",
	partial: "border-amber-200 bg-amber-50 text-amber-900",
	failed: "border-red-200 bg-red-50 text-red-800",
};

/** The contacts files found in the picked files: one row each, with the photo option, Import, Preview and the results. */
export function TakeoutContactsCard({ sources }: TakeoutContactsCardProps) {
	const { t } = useLanguage();
	const { selectedMailbox } = useSelectedMailbox();
	const user = useCurrentUser();
	// A delegate of a shared mailbox gets 404 from the import route, so the buttons are off for them.
	const ownsBook = isAddressBookOwner(selectedMailbox, user?.id);
	const mailbox = selectedMailbox ? `${selectedMailbox.localPart}@${selectedMailbox.hostname}` : null;
	// The parent remounts this card for every scan, so every file starts included.
	const [included, setIncluded] = useState<Record<string, boolean>>(() => Object.fromEntries(sources.map((source) => [source.id, true])));
	const [photos, setPhotos] = useState(true);
	const [progress, setProgress] = useState<ContactRunProgress | null>(null);
	const [results, setResults] = useState<ContactRunResult[]>([]);
	const [error, setError] = useState<string | null>(null);
	// What a screen reader hears: one message when each file starts and one when the run ends, not every batch.
	const [announce, setAnnounce] = useState("");
	const controllerRef = useRef<AbortController | null>(null);
	const running = progress !== null;

	useEffect(() => {
		if (!running) return;
		const onBeforeUnload = (event: BeforeUnloadEvent) => event.preventDefault();
		window.addEventListener("beforeunload", onBeforeUnload);
		return () => window.removeEventListener("beforeunload", onBeforeUnload);
	}, [running]);

	// Leaving the page stops the loop; running it again changes nothing that is already there.
	useEffect(() => () => controllerRef.current?.abort(), []);

	const chosen = sources.filter((source) => included[source.id]);
	const canStart = chosen.length > 0 && !running && !!selectedMailbox && ownsBook;
	const hasVcard = sources.some((source) => source.kind === "vcard");

	async function start(mode: "import" | "preview") {
		if (!canStart || !selectedMailbox) return;
		const mailboxId = selectedMailbox.id;
		setError(null);
		setResults([]);
		const controller = new AbortController();
		controllerRef.current = controller;
		const collected: ContactRunResult[] = [];
		let failed = false;
		try {
			for (const [index, source] of chosen.entries()) {
				const base = { mode, label: source.label, index: index + 1, count: chosen.length, done: 0, total: 0 };
				setProgress(base);
				setAnnounce(t("importPage.takeoutReading", { source: source.label, index: index + 1, count: chosen.length }));
				const bytes = await readTakeoutSource(source);
				const onProgress = (done: number, total: number) => setProgress({ ...base, done, total });
				const summary = mode === "import"
					? await importContactsBytes(bytes, source.kind, { mailboxId, photos }, { post, uploadPhoto: (address, file) => uploadContactAvatar(mailboxId, address, file), signal: controller.signal, onProgress })
					: await previewContactsBytes(bytes, source.kind, { signal: controller.signal, onProgress });
				collected.push({ id: source.id, label: source.label, mode, photos: photos && source.kind === "vcard", summary });
				setResults([...collected]);
				if (summary.aborted || summary.rateLimited) break;
			}
		} catch (caught) {
			failed = true;
			if (!controller.signal.aborted) setError(caught instanceof ContactsFileError ? t(caught.key) : caught instanceof Error ? caught.message : String(caught));
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
				<legend className="text-sm font-medium text-neutral-900">{t("importPage.takeoutDataContacts")}</legend>
				<ul className="divide-y divide-neutral-100 rounded-lg border border-neutral-200">
					{sources.map((source) => (
						<li key={source.id} className="p-3">
							<label className="flex min-h-8 items-center gap-2 text-sm font-medium text-neutral-900">
								<Checkbox checked={!!included[source.id]} onChange={(event) => setIncluded((current) => ({ ...current, [source.id]: event.target.checked }))} />
								<span className="break-all">{source.label}</span>
							</label>
						</li>
					))}
				</ul>
				{mailbox && !ownsBook
					? <p role="status" className="rounded-lg border border-amber-100 bg-amber-50 px-4 py-3 text-sm text-amber-700">{t("importPage.takeoutDataContactsOwnerOnly", { mailbox })}</p>
					: mailbox
					? <p className="text-xs leading-5 text-neutral-500">{t("importPage.takeoutDataContactsTo", { mailbox })}</p>
					: <p role="status" className="rounded-lg border border-amber-100 bg-amber-50 px-4 py-3 text-sm text-amber-700">{t("importPage.selectMailboxFirst")}</p>}
				<p className="text-xs leading-5 text-neutral-500">{t("importPage.takeoutDataContactsNote")}</p>
			</fieldset>
			{hasVcard && (
				<label className="flex items-center gap-2 text-sm text-neutral-700">
					<Checkbox checked={photos} disabled={running} onChange={(event) => setPhotos(event.target.checked)} />
					{t("importPage.takeoutDataPhotos")}
				</label>
			)}
			<p className="rounded-lg border border-neutral-200 bg-neutral-50 px-4 py-3 text-xs leading-5 text-neutral-500">{t("importPage.takeoutKeepOpen")}</p>
			<div className="flex flex-wrap gap-2">
				<Button type="submit" disabled={!canStart}>
					<Upload className="h-4 w-4" />
					{progress?.mode === "import" ? t("import.importing") : t("importPage.takeoutStart")}
				</Button>
				<Button type="button" variant="outline" disabled={!canStart} onClick={() => void start("preview")}>
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
						<span className="shrink-0">{t("importPage.takeoutDataContactsProgress", { done: progress.done, total: progress.total })}</span>
					</div>
					<div className="h-1.5 overflow-hidden rounded-full bg-neutral-100" role="progressbar" aria-label={t("importPage.takeoutReading", { source: progress.label, index: progress.index, count: progress.count })} aria-valuetext={t("importPage.takeoutDataContactsProgress", { done: progress.done, total: progress.total })} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}>
						<div className="h-full bg-blue-600 transition-[width] motion-reduce:transition-none" style={{ width: `${percent}%` }} />
					</div>
				</div>
			)}
			{results.length > 0 && (
				<div className={clsx("space-y-3 rounded-lg border px-4 py-3 text-sm", TONE_CLASSES[contactsTone(results)])}>
					{results.map(({ id, label, mode, photos: withPhotos, summary }) => (
						<div key={id} className="space-y-1">
							<p className="break-all font-medium">{label}</p>
							{summary.aborted && <p className="text-xs">{t("importPage.takeoutStopped")}</p>}
							{summary.rateLimited && <p className="text-xs font-medium">{t("importPage.takeoutDataRateLimited")}</p>}
							<p>{mode === "import"
								? t("importPage.takeoutDataContactsCounts", { created: summary.created, updated: summary.updated, unchanged: summary.unchanged })
								: t("importPage.takeoutDataContactsPreviewResult", { cards: summary.cards, withEmail: summary.withEmail, noEmail: summary.noEmail })}</p>
							{summary.noEmail > 0 && <p className="text-xs">{t("importPage.takeoutDataNoEmail", { count: summary.noEmail, names: summary.noEmailNames.join(", ") || "-" })}</p>}
							{mode === "import" && withPhotos && (summary.photosUploaded > 0 || summary.photosFailed > 0) && <p className="text-xs">{t("importPage.takeoutDataPhotosResult", { uploaded: summary.photosUploaded, failed: summary.photosFailed })}</p>}
							{(summary.failed > 0 || summary.errors.length > 0) && (
								<div className="text-xs font-medium">
									{summary.failed > 0 && <p>{t("importPage.takeoutDataContactsFailed", { count: summary.failed })}</p>}
									<ul className="mt-1 list-disc space-y-0.5 pl-5">
										{summary.errors.map((item, index) => <li key={index} className="break-words">{typeof item === "string" ? item : t(item.key, item.params)}</li>)}
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

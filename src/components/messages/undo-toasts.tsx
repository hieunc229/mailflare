"use client";

import { useSyncExternalStore } from "react";
import { useLanguage } from "@/components/language-provider";
import { undoMessageAction } from "@/lib/messages/actions/client";
import type { ReversibleMessageAction } from "@/lib/messages/actions/types";
import {
	beginUndoToast,
	dismissUndoToast,
	failUndoToast,
	getUndoToasts,
	subscribeUndoToasts,
} from "@/lib/messages/actions/undo-store";
import type { UndoToastEntry } from "@/lib/messages/actions/undo-store";
import type { TranslationKey } from "@/lib/i18n/types";
import { cn } from "@/lib/utils";

const ACTION_LABELS: Record<ReversibleMessageAction, TranslationKey> = {
	archive: "undo.label.archive",
	trash: "undo.label.trash",
	spam: "undo.label.spam",
	inbox: "undo.label.inbox",
	folder: "undo.label.folder",
	read: "undo.label.read",
	unread: "undo.label.unread",
	star: "undo.label.star",
	unstar: "undo.label.unstar",
	snooze: "undo.label.snooze",
	unsnooze: "undo.label.unsnooze",
};

const EMPTY: UndoToastEntry[] = [];

/** Independent stack for message-action undo; compose's single send notice is untouched. */
export function UndoToasts() {
	const { t } = useLanguage();
	const toasts = useSyncExternalStore(subscribeUndoToasts, getUndoToasts, () => EMPTY);
	if (toasts.length === 0) return null;

	async function undo(entry: UndoToastEntry) {
		if (entry.status !== "idle") return;
		beginUndoToast(entry.id);
		try {
			const result = await undoMessageAction(entry);
			if (result.restored.length === 0) failUndoToast(entry.id);
			else dismissUndoToast(entry.id);
		} catch {
			failUndoToast(entry.id);
		}
	}

	return (
		<div className="pointer-events-none fixed bottom-4 left-4 z-[70] flex w-[min(24rem,calc(100vw-2rem))] flex-col gap-2">
			{toasts.map((entry) => {
				const label = t(ACTION_LABELS[entry.action]);
				const text = entry.records.length > 1
					? t("undo.bulk", { action: label, count: entry.records.length })
					: label;
				return (
					<div
						key={entry.id}
						role="status"
						aria-atomic="true"
						className={cn(
							"pointer-events-auto flex items-start gap-3 rounded-lg px-3 py-2.5 text-sm font-medium text-white shadow-lg",
							entry.status === "failed" ? "bg-red-600" : "bg-neutral-800",
						)}
					>
						<div className="min-w-0 flex-1">
							<p className="break-words">{entry.status === "failed" ? t("undo.failed") : text}</p>
							{entry.skipped > 0 && entry.status !== "failed" && (
								<p className="mt-0.5 text-xs font-normal text-white/80">
									{t("undo.partial", { applied: entry.records.length, total: entry.records.length + entry.skipped })}
								</p>
							)}
						</div>
						{entry.status !== "failed" && (
							<button
								type="button"
								onClick={() => void undo(entry)}
								disabled={entry.status === "undoing"}
								className="shrink-0 rounded-md bg-white/20 px-2.5 py-1 font-semibold hover:bg-white/30 disabled:cursor-wait disabled:opacity-60"
							>
								{t("undo.button")}
							</button>
						)}
						<button
							type="button"
							onClick={() => dismissUndoToast(entry.id)}
							aria-label={t("undo.dismiss")}
							className="-mr-1 shrink-0 rounded-md px-1.5 py-0.5 text-base leading-none text-white/70 hover:bg-white/15 hover:text-white"
						>
							<span aria-hidden="true">×</span>
						</button>
					</div>
				);
			})}
		</div>
	);
}

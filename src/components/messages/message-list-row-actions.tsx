"use client";

import { memo, useState } from "react";
import clsx from "clsx";
import { Archive, Clock, Mail, MailOpen, Trash2 } from "@/components/icons";
import { useLanguage } from "@/components/language-provider";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Tooltip } from "@/components/ui/tooltip";
import type { MessageListRowActionsProps } from "./types";
import { MessageUnsubscribeButton } from "./unsubscribe-button";
import type { SnoozePreset } from "./message-list-row-actions-utils";
import { getSnoozePresets, isMessageSnoozed, snoozeMessage, unsnoozeMessage } from "./message-list-row-actions-utils";
import { getUserTimeZone } from "@/lib/time/utils";

function MessageListRowActionsComponent({ message, onAction, compact = false, active = false, onSnoozeChange }: MessageListRowActionsProps) {
	const { t } = useLanguage();
	const [snoozeOpen, setSnoozeOpen] = useState(false);
	const [snoozedUntil, setSnoozedUntil] = useState("");
	const [snoozePresets, setSnoozePresets] = useState<SnoozePreset[]>([]);
	const [snoozing, setSnoozing] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const snoozed = isMessageSnoozed(message.snoozedUntil);
	const readAction = message.read ? "unread" : "read";
	const buttonClassName = compact ? "h-7 w-7 shrink-0 px-0" : undefined;

	function openSnooze() {
		const presets = getSnoozePresets();
		setSnoozePresets(presets);
		if (!snoozedUntil) setSnoozedUntil(presets[0].value);
		setSnoozeOpen(true);
	}

	async function handleSnooze() {
		setSnoozing(true);
		setError(null);
		try {
			await snoozeMessage(message.id, snoozedUntil);
			setSnoozeOpen(false);
			onSnoozeChange?.(message.id, true);
		} catch (nextError) {
			setError(nextError instanceof Error ? nextError.message : t("snooze.failed"));
		} finally {
			setSnoozing(false);
		}
	}

	async function handleUnsnooze() {
		setSnoozing(true);
		setError(null);
		try {
			await unsnoozeMessage(message.id);
			onSnoozeChange?.(message.id, false);
		} catch (nextError) {
			setError(nextError instanceof Error ? nextError.message : t("snooze.failed"));
		} finally {
			setSnoozing(false);
		}
	}

	return (
		<>
			<div
				className={clsx(
					"pointer-events-none absolute z-10 flex items-center opacity-0 transition-opacity group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100",
					compact
						? [
							"inset-y-0 right-0 gap-0.5 pl-3 pr-3",
							"before:pointer-events-none before:absolute before:inset-y-0 before:right-full before:w-5 before:bg-gradient-to-l before:to-transparent before:content-['']",
							active ? "bg-blue-50 before:from-blue-50" : "bg-neutral-50 before:from-neutral-50",
						]
						: "right-6 top-1/2 -translate-y-1/2 gap-1 bg-[#f2f6fc] pl-3",
				)}
			>
				{message.hasUnsubscribe && (
					<MessageUnsubscribeButton key={message.id} messageId={message.id} variant="row" iconOnly={compact} />
				)}
				<Tooltip label={t("common.archive")}>
					<Button type="button" variant="ghost" size="sm" className={buttonClassName} onClick={() => void onAction("archive")} aria-label={t("common.archive")}>
						<Archive className="h-4 w-4" />
					</Button>
				</Tooltip>
				<Tooltip label={t("common.trash")}>
					<Button type="button" variant="ghost" size="sm" className={buttonClassName} onClick={() => void onAction("trash")} aria-label={t("common.trash")}>
						<Trash2 className="h-4 w-4" />
					</Button>
				</Tooltip>
				<Tooltip label={readAction === "read" ? t("common.markRead") : t("common.markUnread")}>
					<Button type="button" variant="ghost" size="sm" className={buttonClassName} onClick={() => void onAction(readAction)} aria-label={readAction === "read" ? t("common.markRead") : t("common.markUnread")}>
						{readAction === "read" ? <MailOpen className="h-4 w-4" /> : <Mail className="h-4 w-4" />}
					</Button>
				</Tooltip>
				<Tooltip label={snoozed ? t("common.unsnooze") : t("common.snooze")}>
					<Button type="button" variant="ghost" size="sm" className={buttonClassName} disabled={snoozing} onClick={() => {
						if (snoozed) {
							void handleUnsnooze();
							return;
						}
						openSnooze();
					}} aria-label={snoozed ? t("common.unsnooze") : t("common.snooze")}>
						<Clock className="h-4 w-4" />
					</Button>
				</Tooltip>
			</div>

			<Dialog open={snoozeOpen} onOpenChange={setSnoozeOpen}>
				<DialogContent>
					<DialogHeader>
						<DialogTitle>{t("snooze.title")}</DialogTitle>
						<DialogDescription>{t("snooze.description")}</DialogDescription>
					</DialogHeader>
					<div className="space-y-4">
						<div className="grid gap-2 sm:grid-cols-3">
							{snoozePresets.map((preset) => (
								<Button key={preset.labelKey} type="button" variant="outline" size="sm" aria-pressed={snoozedUntil === preset.value} onClick={() => setSnoozedUntil(preset.value)}>
									{t(preset.labelKey)}
								</Button>
							))}
						</div>
						<div className="space-y-2">
							<label htmlFor={`snooze-until-${message.id}`} className="text-sm font-medium text-neutral-700">{t("snooze.selectDateTime", { timeZone: getUserTimeZone() })}</label>
							<Input id={`snooze-until-${message.id}`} type="datetime-local" value={snoozedUntil} onChange={(event) => setSnoozedUntil(event.target.value)} />
						</div>
						{error && <p role="alert" className="text-sm text-red-600">{error}</p>}
						<Button type="button" onClick={() => void handleSnooze()} disabled={snoozing}>
							{snoozing ? t("common.snoozing") : t("common.snooze")}
						</Button>
					</div>
				</DialogContent>
			</Dialog>
		</>
	);
}

export const MessageListRowActions = memo(MessageListRowActionsComponent);

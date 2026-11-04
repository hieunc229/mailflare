"use client";

import { useState } from "react";
import { Archive, Clock, Mail, MailOpen, Trash2 } from "@/components/icons";
import { useLanguage } from "@/components/language-provider";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Tooltip } from "@/components/ui/tooltip";
import type { MessageListRowActionsProps } from "./types";
import { getSnoozePresets, isMessageSnoozed, snoozeMessage, unsnoozeMessage } from "./message-list-row-actions-utils";
import { getUserTimeZone } from "@/lib/time/utils";

export function MessageListRowActions({ message, onAction }: MessageListRowActionsProps) {
	const { t } = useLanguage();
	const [snoozeOpen, setSnoozeOpen] = useState(false);
	const [snoozedUntil, setSnoozedUntil] = useState(() => getSnoozePresets()[0].value);
	const [snoozing, setSnoozing] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const snoozePresets = getSnoozePresets();
	const snoozed = isMessageSnoozed(message.snoozedUntil);
	const readAction = message.read ? "unread" : "read";

	async function handleSnooze() {
		setSnoozing(true);
		setError(null);
		try {
			await snoozeMessage(message.id, snoozedUntil);
			setSnoozeOpen(false);
		} catch (nextError) {
			setError(nextError instanceof Error ? nextError.message : t("snooze.failed"));
		} finally {
			setSnoozing(false);
		}
	}

	return (
		<>
			<div className="pointer-events-none absolute right-6 top-1/2 z-10 flex -translate-y-1/2 items-center gap-1 pl-3 opacity-0 transition-opacity group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100 bg-[#f2f6fc] dark:bg-[#f2f6fc]">
				<Tooltip label={t("common.archive")}>
					<Button type="button" variant="ghost" size="sm" onClick={() => void onAction("archive")} aria-label={t("common.archive")}>
						<Archive className="h-4 w-4" />
					</Button>
				</Tooltip>
				<Tooltip label={t("common.trash")}>
					<Button type="button" variant="ghost" size="sm" onClick={() => void onAction("trash")} aria-label={t("common.trash")}>
						<Trash2 className="h-4 w-4" />
					</Button>
				</Tooltip>
				<Tooltip label={readAction === "read" ? t("common.markRead") : t("common.markUnread")}>
					<Button type="button" variant="ghost" size="sm" onClick={() => void onAction(readAction)} aria-label={readAction === "read" ? t("common.markRead") : t("common.markUnread")}>
						{readAction === "read" ? <MailOpen className="h-4 w-4" /> : <Mail className="h-4 w-4" />}
					</Button>
				</Tooltip>
				<Tooltip label={snoozed ? t("common.unsnooze") : t("common.snooze")}>
					<Button type="button" variant="ghost" size="sm" onClick={() => {
						if (snoozed) {
							void unsnoozeMessage(message.id);
							return;
						}
						setSnoozeOpen(true);
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

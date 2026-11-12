"use client";

import { memo, useState } from "react";
import clsx from "clsx";
import { Archive, Clock, Mail, MailOpen, MoreVertical, Trash2 } from "@/components/icons";
import { MessageActionMenu, MessageActionMenuItem, MessageActionMenuSeparator } from "@/components/message-actions/action-menu";
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
	const compactButtonClassName = "h-7 w-7 shrink-0 px-0";

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
			{compact ? (
				<div
					className={clsx(
						"pointer-events-none absolute right-2 top-1/2 z-10 flex h-8 -translate-y-1/2 items-center gap-0.5 rounded-full p-0.5 opacity-0 shadow-sm ring-1 ring-black/5 transition-opacity group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100 has-[[data-state=open]]:opacity-100",
						active ? "bg-blue-50" : "bg-neutral-50",
					)}
				>
					{message.hasUnsubscribe && (
						<MessageUnsubscribeButton key={message.id} messageId={message.id} variant="row" iconOnly />
					)}
					<Tooltip label={t("common.archive")}>
						<Button type="button" variant="ghost" size="sm" className={compactButtonClassName} onClick={() => void onAction("archive")} aria-label={t("common.archive")}>
							<Archive className="h-4 w-4" />
						</Button>
					</Tooltip>
					<MessageActionMenu
						label={t("common.moreActions")}
						trigger={
							<Button type="button" variant="ghost" size="sm" className={compactButtonClassName} aria-label={t("common.moreActions")}>
								<MoreVertical className="h-4 w-4" />
							</Button>
						}
					>
						<MessageActionMenuItem icon={readAction === "read" ? <MailOpen className="h-4 w-4" /> : <Mail className="h-4 w-4" />} onSelect={() => void onAction(readAction)}>
							{readAction === "read" ? t("common.markRead") : t("common.markUnread")}
						</MessageActionMenuItem>
						<MessageActionMenuItem
							icon={<Clock className="h-4 w-4" />}
							disabled={snoozing}
							onSelect={() => {
								if (snoozed) {
									void handleUnsnooze();
									return;
								}
								openSnooze();
							}}
						>
							{snoozed ? t("common.unsnooze") : t("common.snooze")}
						</MessageActionMenuItem>
						<MessageActionMenuSeparator />
						<MessageActionMenuItem icon={<Trash2 className="h-4 w-4" />} destructive onSelect={() => void onAction("trash")}>
							{t("common.trash")}
						</MessageActionMenuItem>
					</MessageActionMenu>
				</div>
			) : (
				<div className="pointer-events-none absolute right-6 top-1/2 z-10 flex -translate-y-1/2 items-center gap-1 bg-[#f2f6fc] pl-3 opacity-0 transition-opacity group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100">
					{message.hasUnsubscribe && (
						<MessageUnsubscribeButton key={message.id} messageId={message.id} variant="row" />
					)}
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
						<Button type="button" variant="ghost" size="sm" disabled={snoozing} onClick={() => {
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
			)}

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

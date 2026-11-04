"use client";

import { createElement, useState, useMemo, useCallback, useRef } from "react";
import { useRouter } from "next/navigation";
import { Archive, Ban, BellOff, Clock, FileCode2, Forward, Mail, MailOpen, MoreVertical, Reply, ReplyAll, ShieldAlert, Trash2 } from "@/components/icons";
import { useLanguage } from "@/components/language-provider";
import { useCompose } from "@/components/compose/compose-context";
import { MessageSourceDialog } from "@/components/messages/message-source-dialog";
import { useDismissible } from "@/components/use-dismissible";
import { useMessageListVisibility } from "@/components/messages/message-list-visibility";
import { MessageSnoozeDialog } from "./message-snooze-dialog";
import { useIsMobile } from "@/components/sidebar-mobile-utils";
import { useHotkeys, useShortcuts } from "@/components/shortcuts";
import { Button } from "@/components/ui/button";
import { Tooltip } from "@/components/ui/tooltip";
import type { BulkMessageAction } from "@/app/api/messages/bulk/types";
import type { MessageActionsProps, ReplyMode } from "./types";
import { getPermanentDeleteConfirmText, PartialDeleteError, supportsPermanentDelete } from "@/lib/messages/permanent-delete-utils";
import {
	confirmTrashWithoutUnsubscribe,
	blockMessageContact,
	createForwardDraft,
	createReplyDraft,
	createTrashSenderRule,
	getMessageActionRedirect,
	getMessageBackHref,
	getMoveMessageActions,
	getReplyRecipients,
	getReplyThreading,
	hasAdditionalRecipients,
	openUnsubscribeUrl,
	runSingleMessageAction,
} from "./utils";

export function MessageActions({
	messageId,
	mailboxId,
	senderAddress,
	direction,
	status,
	read,
	unsubscribeUrl,
	subject,
	bodyText,
	ownAddress,
	ownAddresses = [],
	message,
	messageMeta,
	bodyHtml,
}: MessageActionsProps) {
	const { t } = useLanguage();
	const router = useRouter();
	const isMobile = useIsMobile();
	const { openDraftComposer } = useCompose();
	const { backHref: listHref } = useMessageListVisibility();
	const { shortcutsEnabled } = useShortcuts();
	const [pendingAction, setPendingAction] = useState<
		BulkMessageAction | "unsubscribe" | ReplyMode | "forward" | "block" | null
	>(null);
	const [error, setError] = useState<string | null>(null);
	const [moreOpen, setMoreOpen] = useState(false);
	const moreRef = useRef<HTMLDivElement>(null);
	useDismissible(moreOpen, () => setMoreOpen(false), moreRef);
	const [sourceOpen, setSourceOpen] = useState(false);
	const [snoozeOpen, setSnoozeOpen] = useState(false);

	const runAction = useCallback(async (action: BulkMessageAction) => {
		setMoreOpen(false);
		setPendingAction(action);
		setError(null);
		try {
			await runSingleMessageAction(messageId, action);
			const redirect = getMessageActionRedirect(action, listHref);
			if (redirect) router.push(redirect);
			router.refresh();
		} catch {
			setError(t("actions.error.update"));
		} finally {
			setPendingAction(null);
		}
	}, [messageId, listHref, router, t]);

	// In Trash and Spam the delete button removes the message for good instead of
	// being a no-op, after the user confirms.
	const canDeleteForever = supportsPermanentDelete(status);
	const deleteForever = useCallback(async () => {
		if (!window.confirm(getPermanentDeleteConfirmText(1, t))) return;
		setMoreOpen(false);
		setPendingAction("delete");
		setError(null);
		try {
			await runSingleMessageAction(messageId, "delete");
			router.push(getMessageBackHref(direction, status));
			router.refresh();
		} catch (deleteError) {
			setError(deleteError instanceof PartialDeleteError ? t("actions.error.deleteSkipped") : t("actions.error.delete"));
			setPendingAction(null);
		}
	}, [messageId, direction, status, router, t]);
	const onTrashClick = () => (canDeleteForever ? void deleteForever() : void runAction("trash"));
	const trashLabel = canDeleteForever ? t("common.deleteForever") : t("actions.moveToTrash");

	const replyable = useMemo(() => message ?? {
		direction,
		fromAddr: senderAddress,
		toAddr: "",
		ccAddr: null,
		replyTo: null,
		providerMessageId: null,
		references: null,
		threadId: null,
	}, [message, direction, senderAddress]);
	const canReplyAll = hasAdditionalRecipients(replyable, ownAddresses);

	const handleReply = useCallback(async (mode: ReplyMode) => {
		setPendingAction(mode);
		setError(null);
		try {
			const draftId = await createReplyDraft({
				mailboxId,
				senderAddress,
				ownAddress,
				subject,
				bodyText,
				bodyHtml,
				sentAt: messageMeta?.createdAt,
				recipients: getReplyRecipients(replyable, ownAddresses, mode),
				threading: getReplyThreading(replyable),
			});
			openDraftComposer(draftId);
		} catch (replyError) {
			setError(replyError instanceof Error ? replyError.message : t("message.error.reply"));
		} finally {
			setPendingAction(null);
		}
	}, [mailboxId, senderAddress, ownAddress, subject, bodyText, bodyHtml, messageMeta?.createdAt, replyable, ownAddresses, openDraftComposer, t]);

	const shortcuts = useMemo(
		() => [
			{
				key: "e",
				label: t("shortcut.archiveMessage"),
				category: "Actions" as const,
				action: () => {
					if (status !== "archived") void runAction("archive");
				},
			},
			{
				key: "y",
				label: t("shortcut.archiveMessage"),
				category: "Actions" as const,
				action: () => {
					if (status !== "archived") void runAction("archive");
				},
			},
			{
				key: "#",
				label: t("shortcut.moveToTrash"),
				category: "Actions" as const,
				action: () => {
					if (status !== "trash") void runAction("trash");
				},
			},
			{
				key: "r",
				label: t("shortcut.replyToMessage"),
				category: "Composing" as const,
				action: () => void handleReply("reply"),
			},
			{
				key: "!",
				label: t("shortcut.reportSpam"),
				category: "Actions" as const,
				action: () => {
					if (status !== "spam" && direction === "inbound") void runAction("spam");
				},
			},
			{
				key: "u",
				label: t("shortcut.backToList"),
				category: "Navigation" as const,
				action: () => router.back(),
			},
		],
		[status, direction, runAction, handleReply, router, t]
	);

	useHotkeys(shortcuts, { enabled: shortcutsEnabled });

	async function onUnsubscribe() {
		setMoreOpen(false);
		setError(null);
		if (unsubscribeUrl) {
			openUnsubscribeUrl(unsubscribeUrl);
			return;
		}

		if (!confirmTrashWithoutUnsubscribe()) return;
		setPendingAction("unsubscribe");
		if (!mailboxId) {
			setError(t("actions.error.trashRule"));
			setPendingAction(null);
			return;
		}

		try {
			await createTrashSenderRule({ mailboxId, senderAddress });
			await runAction("trash");
		} catch {
			setError(t("actions.error.trashRule"));
			setPendingAction(null);
		}
	}

	async function handleForward() {
		if (!message || !messageMeta) return;
		setPendingAction("forward");
		setError(null);
		try {
			const draftId = await createForwardDraft({
				mailboxId,
				ownAddress,
				message: { ...message, ...messageMeta },
				bodyText,
				bodyHtml,
			});
			openDraftComposer(draftId);
		} catch (forwardError) {
			setError(forwardError instanceof Error ? forwardError.message : t("message.error.forward"));
		} finally {
			setPendingAction(null);
		}
	}
	async function onBlockContact() {
		setMoreOpen(false);
		setError(null);
		if (!mailboxId) {
			setError(t("message.error.block"));
			return;
		}

		setPendingAction("block");
		try {
			await blockMessageContact({ mailboxId, senderAddress });
			await runSingleMessageAction(messageId, "trash");
			router.push(listHref);
			router.refresh();
		} catch (blockError) {
			setError(blockError instanceof Error ? blockError.message : t("message.error.block"));
		} finally {
			setPendingAction(null);
		}
	}

	const disabled = pendingAction !== null;
	const markAction: BulkMessageAction = read ? "unread" : "read";
	const moveActions = getMoveMessageActions(status, direction);

	return (
		<div className="flex flex-wrap items-center gap-3 text-neutral-600 flex-1 min-w-0">
			{error && <span role="alert" className="text-xs text-red-600">{error}</span>}

			{isMobile && (
				<>
					<Button
						variant="ghost"
						size="roundedSM"
						aria-label={trashLabel}
						disabled={disabled}
						onClick={onTrashClick}
					>
						<Trash2 size={iconSize} />
					</Button>
					<Button
						variant="ghost"
						size="roundedSM"
						aria-label={t("common.reportSpam")}
						disabled={disabled || status === "spam" || direction !== "inbound"}
						onClick={() => runAction("spam")}
					>
						<ShieldAlert size={iconSize} />
					</Button>
				</>
			)}
			{!isMobile && (
				<>
			<Tooltip label={shortcutsEnabled ? t("actions.archiveHint") : t("common.archive")}>
				<Button
					variant="ghost"
					size="roundedSM"
					aria-label={shortcutsEnabled ? t("actions.archiveHint") : t("common.archive")}
					disabled={disabled || status === "archived"}
					onClick={() => runAction("archive")}
				>
					<Archive size={iconSize} />
				</Button>
			</Tooltip>
			<Tooltip label={shortcutsEnabled ? t("actions.reportSpamHint") : t("common.reportSpam")}>
				<Button
					variant="ghost"
					size="roundedSM"
					aria-label={shortcutsEnabled ? t("actions.reportSpamHint") : t("common.reportSpam")}
					disabled={disabled || status === "spam" || direction !== "inbound"}
					onClick={() => runAction("spam")}
				>
					<ShieldAlert size={iconSize} />
				</Button>
			</Tooltip>
			<Tooltip label={canDeleteForever ? t("common.deleteForever") : shortcutsEnabled ? t("actions.deleteHint") : t("common.delete")}>
				<Button
					variant="ghost"
					size="roundedSM"
					aria-label={canDeleteForever ? trashLabel : shortcutsEnabled ? t("actions.moveToTrashHint") : t("actions.moveToTrash")}
					disabled={disabled}
					onClick={onTrashClick}
					className={canDeleteForever ? "text-red-600 hover:text-red-700" : undefined}
				>
					<Trash2 size={iconSize} />
				</Button>
			</Tooltip>
			<span className="h-5 mx-2 bg-gray-200 w-px inline-block" />


			<Tooltip label={shortcutsEnabled ? t("actions.replyHint") : t("message.reply")}>
				<Button
					type="button"
					variant="ghost"
					size="roundedSM"
					aria-label={shortcutsEnabled ? t("actions.replyHint") : t("message.reply")}
					disabled={disabled}
					onClick={() => handleReply("reply")}
				>
					<Reply size={iconSize} />
				</Button>
			</Tooltip>
			{canReplyAll && (
				<Tooltip label={t("message.replyAll")}>
					<Button
						type="button"
						variant="ghost"
						size="roundedSM"
						aria-label={t("message.replyAll")}
						disabled={disabled}
						onClick={() => handleReply("replyAll")}
					>
						<ReplyAll size={iconSize} />
					</Button>
				</Tooltip>
			)}
			{message && messageMeta && (
				<Tooltip label={t("message.forward")}>
					<Button
						type="button"
						variant="ghost"
						size="roundedSM"
						aria-label={t("message.forward")}
						disabled={disabled}
						onClick={() => void handleForward()}
					>
						<Forward size={iconSize} />
					</Button>
				</Tooltip>
			)}

			<Tooltip label={read ? t("common.markUnread") : t("common.markRead")}>
				<Button
					variant="ghost"
					size="roundedSM"
					aria-label={read ? t("common.markUnread") : t("common.markRead")}
					disabled={disabled}
					onClick={() => runAction(markAction)}
				>
					{read ? <Mail size={iconSize} /> : <MailOpen size={iconSize} />}
				</Button>
			</Tooltip>
				</>
			)}
			<div ref={moreRef} className="relative">
				<Tooltip label={t("common.moreActions")}>
					<Button
						type="button"
						variant="ghost"
						size="roundedSM"
						aria-label={t("common.moreActions")}
						aria-expanded={moreOpen}
						disabled={disabled}
						onClick={() => setMoreOpen((open) => !open)}
					>
						<MoreVertical size={iconSize} />
					</Button>
				</Tooltip>


				{moreOpen && (
					<div className="absolute right-0 top-8 z-20 w-54 rounded-xl border border-neutral-200 bg-white p-2 shadow-lg">
						{isMobile && (
							<>
								<button type="button" className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-neutral-700 hover:bg-neutral-100 disabled:text-neutral-400" disabled={status === "archived"} onClick={() => void runAction("archive")}>
									<Archive className="h-4 w-4" />
									{t("common.archive")}
								</button>
								<button type="button" className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-neutral-700 hover:bg-neutral-100 disabled:text-neutral-400" onClick={() => { setMoreOpen(false); void handleReply("reply"); }}>
									<Reply className="h-4 w-4" />
									{t("message.reply")}
								</button>
								{canReplyAll && (
									<button type="button" className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-neutral-700 hover:bg-neutral-100 disabled:text-neutral-400" onClick={() => { setMoreOpen(false); void handleReply("replyAll"); }}>
										<ReplyAll className="h-4 w-4" />
										{t("message.replyAll")}
									</button>
								)}
								{message && messageMeta && (
									<button type="button" className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-neutral-700 hover:bg-neutral-100 disabled:text-neutral-400" onClick={() => { setMoreOpen(false); void handleForward(); }}>
										<Forward className="h-4 w-4" />
										{t("message.forward")}
									</button>
								)}
								<button type="button" className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-neutral-700 hover:bg-neutral-100 disabled:text-neutral-400" onClick={() => void runAction(markAction)}>
									{read ? <Mail className="h-4 w-4" /> : <MailOpen className="h-4 w-4" />}
									{read ? t("common.markUnread") : t("common.markRead")}
								</button>
								<hr className="my-1 border-neutral-100" />
							</>
						)}
						{direction === "inbound" && status === "received" && (
							<button
								type="button"
								className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-neutral-700 hover:bg-neutral-100"
								onClick={() => { setMoreOpen(false); setSnoozeOpen(true); }}
							>
								<Clock className="h-4 w-4" />
								{t("common.snooze")}
							</button>
						)}
						{direction === "inbound" && (
							<>
								<button
									type="button"
									className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-neutral-700 hover:bg-neutral-100 disabled:cursor-not-allowed disabled:text-neutral-400"
									disabled={!unsubscribeUrl && status === "trash"}
									onClick={() => void onUnsubscribe()}
								>
									<BellOff className="h-4 w-4 shrink-0" />
									{t("actions.unsubscribe")}
								</button>
								<button
									type="button"
									className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-neutral-700 hover:bg-neutral-100"
									onClick={() => void onBlockContact()}
								>
									<Ban className="h-4 w-4" />
									{t("message.blockContact")}
								</button>
								<hr className="my-1 border-neutral-100" />
							</>
						)}
						<button
							type="button"
							className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-neutral-700 hover:bg-neutral-100"
							onClick={() => { setMoreOpen(false); setSourceOpen(true); }}
						>
							<FileCode2 className="h-4 w-4" />
							{t("message.showOriginal")}
						</button>
						<hr className="my-1 border-neutral-100" />
						<p className="mt-1 px-3 pb-1 pt-2 text-sm font-medium text-neutral-500">
							{t("common.moveTo")}
						</p>
						{moveActions.map((item) => (
							<button
								key={item.action}
								type="button"
								className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-neutral-700 hover:bg-neutral-100"
								onClick={() => void runAction(item.action)}
							>
								{createElement(item.icon, { size: 16 })}
								{t(item.labelKey)}
							</button>
						))}
					</div>
				)}

			</div>

			<MessageSourceDialog messageId={messageId} open={sourceOpen} onOpenChange={setSourceOpen} />
			<MessageSnoozeDialog messageId={messageId} open={snoozeOpen} onOpenChange={setSnoozeOpen} />

			<span className="flex-1" />
		</div>
	);
}


const iconSize = 16;

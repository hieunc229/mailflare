"use client";

import { createElement, useEffect, useState } from "react";
import { Ban, FileCode2, Forward, Info, Mail, MailOpen, MoreVertical, Reply, ReplyAll, Star } from "@/components/icons";
import { useCompose } from "@/components/compose/compose-context";
import { MessageSourceDialog } from "@/components/messages/message-source-dialog";
import { MessageActionMenu, MessageActionMenuItem, MessageActionMenuSeparator } from "@/components/message-actions/action-menu";
import { getOwnAddressForMessage } from "@/app/(dashboard)/inbox/[messageId]/utils";
import { useLanguage } from "@/components/language-provider";
import { Button } from "@/components/ui/button";
import { Tooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import {
	blockMessageContact,
	createForwardDraft,
	createReplyDraft,
	getMoveMessageActions,
	getReplyRecipients,
	getReplyThreading,
	hasAdditionalRecipients,
	runSingleMessageAction,
} from "@/components/message-actions/utils";
import { toggleMessageStar } from "./message-list-row-actions-utils";
import type { ThreadMessageActionsProps } from "./thread-message-actions-types";
import type { ReplyMode } from "@/components/message-actions/types";

export function ThreadMessageActions({
	message,
	mailboxId,
	ownAddress,
	ownAddresses = [],
	starOnly = false,
	detailsOpen = false,
	onToggleDetails,
}: ThreadMessageActionsProps) {
	const { t } = useLanguage();
	const { openDraftComposer } = useCompose();
	const [starred, setStarred] = useState(message.starred);
	const [sourceOpen, setSourceOpen] = useState(false);
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const canReplyAll = hasAdditionalRecipients(message, ownAddresses);
	const moveActions = getMoveMessageActions(message.status, message.direction);
	const replyFromAddress = ownAddresses.length > 0
		? getOwnAddressForMessage(message, ownAddresses)
		: ownAddress;

	useEffect(() => setStarred(message.starred), [message.starred]);

	async function onToggleStar() {
		setPending(true);
		setError(null);
		try {
			setStarred((await toggleMessageStar(message.id)).starred);
		} catch (nextError) {
			setError(nextError instanceof Error ? nextError.message : t("message.error.star"));
		} finally {
			setPending(false);
		}
	}

	async function onReply(mode: ReplyMode) {
		setPending(true);
		setError(null);
		try {
			const draftId = await createReplyDraft({
				mailboxId,
				senderAddress: message.fromAddr,
				ownAddress: replyFromAddress,
				subject: message.subject,
				bodyText: message.textBody,
				bodyHtml: message.htmlBody,
				sentAt: message.createdAt,
				recipients: getReplyRecipients(message, ownAddresses, mode),
				threading: getReplyThreading(message),
			});
			openDraftComposer(draftId);
		} catch (nextError) {
			setError(nextError instanceof Error ? nextError.message : t("message.error.reply"));
		} finally {
			setPending(false);
		}
	}

	async function onForward() {
		setPending(true);
		setError(null);
		try {
			const draftId = await createForwardDraft({
				mailboxId,
				ownAddress: replyFromAddress,
				message,
				bodyText: message.textBody,
				bodyHtml: message.htmlBody,
			});
			openDraftComposer(draftId);
		} catch (nextError) {
			setError(nextError instanceof Error ? nextError.message : t("message.error.forward"));
		} finally {
			setPending(false);
		}
	}

	async function onMessageAction(action: Parameters<typeof runSingleMessageAction>[1]) {
		setPending(true);
		setError(null);
		try {
			await runSingleMessageAction(message.id, action);
		} catch (nextError) {
			setError(nextError instanceof Error ? nextError.message : t("message.error.update"));
		} finally {
			setPending(false);
		}
	}

	async function onBlock() {
		if (!mailboxId) return;
		setPending(true);
		setError(null);
		try {
			await blockMessageContact({ mailboxId, senderAddress: message.fromAddr });
			await runSingleMessageAction(message.id, "trash");
		} catch (nextError) {
			setError(nextError instanceof Error ? nextError.message : t("message.error.block"));
		} finally {
			setPending(false);
		}
	}

	return (
		<div className="flex items-center gap-0.5">
			{error && <span role="alert" className="mr-1 max-w-32 truncate text-xs text-red-600" title={error}>{error}</span>}
			{onToggleDetails && (
				<Tooltip label={t("message.details")}>
					<Button
						type="button"
						variant="ghost"
						size="sm"
						className={cn("h-8 w-8 px-0", detailsOpen && "bg-neutral-100 text-neutral-900")}
						aria-label={t("message.details")}
						aria-expanded={detailsOpen}
						onClick={onToggleDetails}
					>
						<Info className="h-4 w-4" />
					</Button>
				</Tooltip>
			)}
			<Tooltip label={starred ? t("message.removeStar") : t("message.star")}>
				<Button
					type="button"
					variant="ghost"
					size="sm"
					className="h-8 w-8 px-0"
					aria-label={starred ? t("message.removeStar") : t("message.star")}
					aria-pressed={starred}
					disabled={pending}
					onClick={() => void onToggleStar()}
				>
					<Star className={starred ? "h-4 w-4 fill-amber-400 text-amber-400" : "h-4 w-4"} />
				</Button>
			</Tooltip>
			{!starOnly && (
				<>
					<Tooltip label={t("message.reply")}>
						<Button
							type="button"
							variant="ghost"
							size="sm"
							className="h-8 w-8 px-0"
							aria-label={t("message.reply")}
							disabled={pending}
							onClick={() => void onReply("reply")}
						>
							<Reply className="h-4 w-4" />
						</Button>
					</Tooltip>
					<MessageActionMenu
						label={t("common.moreActions")}
						trigger={
							<Button
								type="button"
								variant="ghost"
								size="sm"
								className="h-8 w-8 px-0"
								aria-label={t("common.moreActions")}
								disabled={pending}
							>
								<MoreVertical className="h-4 w-4" />
							</Button>
						}
					>
						<MessageActionMenuItem icon={<Reply className="h-4 w-4" />} onSelect={() => void onReply("reply")}>
							{t("message.reply")}
						</MessageActionMenuItem>
						{canReplyAll && (
							<MessageActionMenuItem icon={<ReplyAll className="h-4 w-4" />} onSelect={() => void onReply("replyAll")}>
								{t("message.replyAll")}
							</MessageActionMenuItem>
						)}
						<MessageActionMenuItem icon={<Forward className="h-4 w-4" />} onSelect={() => void onForward()}>
							{t("message.forward")}
						</MessageActionMenuItem>
						<MessageActionMenuItem icon={<FileCode2 className="h-4 w-4" />} onSelect={() => setSourceOpen(true)}>
							{t("message.showOriginal")}
						</MessageActionMenuItem>
						<MessageActionMenuSeparator />
						<MessageActionMenuItem
							icon={message.read ? <Mail className="h-4 w-4" /> : <MailOpen className="h-4 w-4" />}
							onSelect={() => void onMessageAction(message.read ? "unread" : "read")}
						>
							{message.read ? t("common.markUnread") : t("common.markRead")}
						</MessageActionMenuItem>
						{moveActions.map((item) => (
							<MessageActionMenuItem
								key={item.action}
								icon={createElement(item.icon, { size: 16 })}
								onSelect={() => void onMessageAction(item.action)}
							>
								{t(item.labelKey)}
							</MessageActionMenuItem>
						))}
						{message.direction === "inbound" && mailboxId && (
							<>
								<MessageActionMenuSeparator />
								<MessageActionMenuItem icon={<Ban className="h-4 w-4" />} onSelect={() => void onBlock()}>
									{t("message.blockContact")}
								</MessageActionMenuItem>
							</>
						)}
					</MessageActionMenu>
					<MessageSourceDialog messageId={message.id} open={sourceOpen} onOpenChange={setSourceOpen} />
				</>
			)}
		</div>
	);
}

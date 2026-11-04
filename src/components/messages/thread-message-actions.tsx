"use client";

import { createElement, useEffect, useRef, useState } from "react";
import { Ban, FileCode2, Forward, Info, Mail, MailOpen, MoreVertical, Reply, ReplyAll, Star } from "@/components/icons";
import { useCompose } from "@/components/compose/compose-context";
import { MessageSourceDialog } from "@/components/messages/message-source-dialog";
import { useDismissible } from "@/components/use-dismissible";
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
	const [moreOpen, setMoreOpen] = useState(false);
	const moreRef = useRef<HTMLDivElement>(null);
	useDismissible(moreOpen, () => setMoreOpen(false), moreRef);
	const [sourceOpen, setSourceOpen] = useState(false);
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const canReplyAll = hasAdditionalRecipients(message, ownAddresses);
	const moveActions = getMoveMessageActions(message.status, message.direction);
	const replyFromAddress = ownAddresses.length > 0
		? getOwnAddressForMessage(message, ownAddresses)
		: ownAddress;

	useEffect(() => setStarred(message.starred), [message.starred]);
	useEffect(() => {
		if (starOnly) setMoreOpen(false);
	}, [starOnly]);

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
		setMoreOpen(false);
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
		setMoreOpen(false);
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
		setMoreOpen(false);
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
		setMoreOpen(false);
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
			<div ref={moreRef} className="relative">
				<Tooltip label={t("common.moreActions")}>
					<Button
						type="button"
						variant="ghost"
						size="sm"
						className="h-8 w-8 px-0"
						aria-label={t("common.moreActions")}
						aria-expanded={moreOpen}
						disabled={pending}
						onClick={() => setMoreOpen((open) => !open)}
					>
						<MoreVertical className="h-4 w-4" />
					</Button>
				</Tooltip>
				{moreOpen && (
					<div className="absolute right-0 z-30 mt-1 w-56 rounded-xl border border-neutral-200 bg-white p-2 text-neutral-700 shadow-lg">
						<button type="button" className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm hover:bg-neutral-100" onClick={() => void onReply("reply")}>
							<Reply className="h-4 w-4" /> {t("message.reply")}
						</button>
						{canReplyAll && (
							<button type="button" className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm hover:bg-neutral-100" onClick={() => void onReply("replyAll")}>
								<ReplyAll className="h-4 w-4" /> {t("message.replyAll")}
							</button>
						)}
						<button type="button" className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm hover:bg-neutral-100" onClick={() => void onForward()}>
							<Forward className="h-4 w-4" /> {t("message.forward")}
						</button>
						<button type="button" className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm hover:bg-neutral-100" onClick={() => { setMoreOpen(false); setSourceOpen(true); }}>
							<FileCode2 className="h-4 w-4" /> {t("message.showOriginal")}
						</button>
						<hr className="my-1 border-neutral-100" />
						<button type="button" className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm hover:bg-neutral-100" onClick={() => void onMessageAction(message.read ? "unread" : "read")}>
							{message.read ? <Mail className="h-4 w-4" /> : <MailOpen className="h-4 w-4" />}
							{message.read ? t("common.markUnread") : t("common.markRead")}
						</button>
						{moveActions.map((item) => (
							<button key={item.action} type="button" className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm hover:bg-neutral-100" onClick={() => void onMessageAction(item.action)}>
								{createElement(item.icon, { size: 16 })} {t(item.labelKey)}
							</button>
						))}
						{message.direction === "inbound" && mailboxId && (
							<>
								<hr className="my-1 border-neutral-100" />
								<button type="button" className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm hover:bg-neutral-100" onClick={() => void onBlock()}>
									<Ban className="h-4 w-4" /> {t("message.blockContact")}
								</button>
							</>
						)}
					</div>
				)}
			</div>
			<MessageSourceDialog messageId={message.id} open={sourceOpen} onOpenChange={setSourceOpen} />
				</>
			)}
		</div>
	);
}

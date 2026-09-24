"use client";

import { createElement, useState, useMemo, useCallback } from "react";
import { useRouter } from "next/navigation";
import { Archive, Ban, BellOff, FileCode2, Forward, Mail, MailOpen, MoreVertical, Reply, ReplyAll, ShieldAlert, Trash2 } from "lucide-react";
import { useCompose } from "@/components/compose/compose-context";
import { MessageSourceDialog } from "@/components/messages/message-source-dialog";
import { useHotkeys, useShortcuts } from "@/components/shortcuts";
import { Button } from "@/components/ui/button";
import { Tooltip } from "@/components/ui/tooltip";
import type { BulkMessageAction } from "@/app/api/messages/bulk/types";
import type { MessageActionsProps, ReplyMode } from "./types";
import {
	confirmTrashWithoutUnsubscribe,
	blockMessageContact,
	createForwardDraft,
	createReplyDraft,
	createTrashSenderRule,
	getMessageActionRedirect,
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
	const router = useRouter();
	const { openDraftComposer } = useCompose();
	const { shortcutsEnabled } = useShortcuts();
	const [pendingAction, setPendingAction] = useState<
		BulkMessageAction | "unsubscribe" | ReplyMode | "forward" | "block" | null
	>(null);
	const [error, setError] = useState<string | null>(null);
	const [moreOpen, setMoreOpen] = useState(false);
	const [sourceOpen, setSourceOpen] = useState(false);

	const runAction = useCallback(async (action: BulkMessageAction) => {
		setMoreOpen(false);
		setPendingAction(action);
		setError(null);
		try {
			await runSingleMessageAction(messageId, action);
			const redirect = getMessageActionRedirect(action, direction);
			if (redirect) router.push(redirect);
			router.refresh();
		} catch {
			setError("Could not update message");
		} finally {
			setPendingAction(null);
		}
	}, [messageId, direction, router]);

	const replyable = useMemo(() => message ?? {
		direction,
		fromAddr: senderAddress,
		toAddr: "",
		ccAddr: null,
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
			setError(replyError instanceof Error ? replyError.message : "Could not start reply");
		} finally {
			setPendingAction(null);
		}
	}, [mailboxId, senderAddress, ownAddress, subject, bodyText, bodyHtml, messageMeta?.createdAt, replyable, ownAddresses, openDraftComposer]);

	const shortcuts = useMemo(
		() => [
			{
				key: "e",
				label: "Archive Message",
				category: "Actions" as const,
				action: () => {
					if (status !== "archived") void runAction("archive");
				},
			},
			{
				key: "y",
				label: "Archive Message",
				category: "Actions" as const,
				action: () => {
					if (status !== "archived") void runAction("archive");
				},
			},
			{
				key: "#",
				label: "Move to Trash",
				category: "Actions" as const,
				action: () => {
					if (status !== "trash") void runAction("trash");
				},
			},
			{
				key: "r",
				label: "Reply to Message",
				category: "Composing" as const,
				action: () => void handleReply("reply"),
			},
			{
				key: "!",
				label: "Report Spam",
				category: "Actions" as const,
				action: () => {
					if (status !== "spam" && direction === "inbound") void runAction("spam");
				},
			},
			{
				key: "u",
				label: "Back to List",
				category: "Navigation" as const,
				action: () => router.back(),
			},
		],
		[status, direction, runAction, handleReply, router]
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
			setError("Could not create trash rule");
			setPendingAction(null);
			return;
		}

		try {
			await createTrashSenderRule({ mailboxId, senderAddress });
			await runAction("trash");
		} catch {
			setError("Could not create trash rule");
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
			setError(forwardError instanceof Error ? forwardError.message : "Could not start forward");
		} finally {
			setPendingAction(null);
		}
	}
	async function onBlockContact() {
		setMoreOpen(false);
		setError(null);
		if (!mailboxId) {
			setError("Could not block contact");
			return;
		}

		setPendingAction("block");
		try {
			await blockMessageContact({ mailboxId, senderAddress });
			await runSingleMessageAction(messageId, "trash");
			router.push("/trash");
			router.refresh();
		} catch (blockError) {
			setError(blockError instanceof Error ? blockError.message : "Could not block contact");
		} finally {
			setPendingAction(null);
		}
	}

	const disabled = pendingAction !== null;
	const markAction: BulkMessageAction = read ? "unread" : "read";
	const moveActions = getMoveMessageActions(status, direction);

	return (
		<div className="flex flex-wrap items-center justify-end gap-3 text-neutral-600">
			{error && <span className="text-xs text-red-600">{error}</span>}
			<div className="flex flex-wrap items-center justify-end gap-1 sm:gap-2">
				<Tooltip label={shortcutsEnabled ? "Reply (r)" : "Reply"}>
					<Button
						type="button"
						variant="ghost"
						size="sm"
						aria-label={shortcutsEnabled ? "Reply (r)" : "Reply"}
						disabled={disabled}
						onClick={() => handleReply("reply")}
					>
						<Reply className="h-5 w-5" />
					</Button>
				</Tooltip>
				{canReplyAll && (
					<Tooltip label="Reply all">
						<Button
							type="button"
							variant="ghost"
							size="sm"
							aria-label="Reply all"
							disabled={disabled}
							onClick={() => handleReply("replyAll")}
						>
							<ReplyAll className="h-5 w-5" />
						</Button>
					</Tooltip>
				)}
				{message && messageMeta && (
					<Tooltip label="Forward">
						<Button
							type="button"
							variant="ghost"
							size="sm"
							aria-label="Forward"
							disabled={disabled}
							onClick={() => void handleForward()}
						>
							<Forward className="h-5 w-5" />
						</Button>
					</Tooltip>
				)}
				<Tooltip label={shortcutsEnabled ? "Archive (e)" : "Archive"}>
					<Button
						variant="ghost"
						size="sm"
						aria-label={shortcutsEnabled ? "Archive (e)" : "Archive"}
						disabled={disabled || status === "archived"}
						onClick={() => runAction("archive")}
					>
						<Archive className="h-5 w-5" />
					</Button>
				</Tooltip>
				<Tooltip label={shortcutsEnabled ? "Report spam (!)" : "Report spam"}>
					<Button
						variant="ghost"
						size="sm"
						aria-label={shortcutsEnabled ? "Report spam (!)" : "Report spam"}
						disabled={disabled || status === "spam" || direction !== "inbound"}
						onClick={() => runAction("spam")}
					>
						<ShieldAlert className="h-5 w-5" />
					</Button>
				</Tooltip>
				<Tooltip label={shortcutsEnabled ? "Delete (#)" : "Delete"}>
					<Button
						variant="ghost"
						size="sm"
						aria-label={shortcutsEnabled ? "Move to trash (#)" : "Move to trash"}
						disabled={disabled || status === "trash"}
						onClick={() => runAction("trash")}
					>
						<Trash2 className="h-5 w-5" />
					</Button>
				</Tooltip>
				<Tooltip label={read ? "Mark as unread" : "Mark as read"}>
					<Button
						variant="ghost"
						size="sm"
						aria-label={read ? "Mark as unread" : "Mark as read"}
						disabled={disabled}
						onClick={() => runAction(markAction)}
					>
						{read ? <Mail className="h-5 w-5" /> : <MailOpen className="h-5 w-5" />}
					</Button>
				</Tooltip>
				<div className="relative">
					<Tooltip label="More actions">
						<Button
							type="button"
							variant="ghost"
							size="sm"
							aria-label="More actions"
							aria-expanded={moreOpen}
							disabled={disabled}
							onClick={() => setMoreOpen((open) => !open)}
						>
							<MoreVertical className="h-5 w-5" />
						</Button>
					</Tooltip>
					{moreOpen && (
						<div className="absolute right-0 z-20 mt-2 w-54 rounded-xl border border-neutral-200 bg-white p-2 shadow-lg">
							{direction === "inbound" && (
								<>
									<button
										type="button"
									className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-neutral-700 hover:bg-neutral-100 disabled:cursor-not-allowed disabled:text-neutral-400"
									disabled={!unsubscribeUrl && status === "trash"}
									onClick={() => void onUnsubscribe()}
								>
									<BellOff className="h-4 w-4 shrink-0" />
									Unsubscribe
									</button>
									<button
										type="button"
									className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-neutral-700 hover:bg-neutral-100"
										onClick={() => void onBlockContact()}
									>
										<Ban className="h-4 w-4" />
										Block contact
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
								Show original
							</button>
							<hr className="my-1 border-neutral-100" />
							<p className="mt-1 px-3 pb-1 pt-2 text-sm font-medium text-neutral-500">
								Move to
							</p>
							{moveActions.map((item) => (
								<button
									key={item.action}
									type="button"
									className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-neutral-700 hover:bg-neutral-100"
									onClick={() => void runAction(item.action)}
								>
									{createElement(item.icon, { size: 16 })}
									{item.label}
								</button>
							))}
						</div>
					)}
				</div>
			</div>
			<MessageSourceDialog messageId={messageId} open={sourceOpen} onOpenChange={setSourceOpen} />
		</div>
	);
}

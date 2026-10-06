"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import type { MouseEvent } from "react";
import { Archive, ChevronLeft, ChevronRight, ListFilter, Mail, MailOpen, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Tooltip } from "@/components/ui/tooltip";
import { useMailSearch } from "@/components/mail-search/mail-search-context";
import { useSelectedMailbox } from "@/components/mailbox-provider";
import { usePageLoading } from "@/components/page-loading";
import { useIsMobile } from "@/components/sidebar-mobile-utils";
import { useMessageCounts } from "@/hooks/use-message-counts";
import { useMessages } from "@/hooks/use-messages";
import type { BulkMessageAction } from "@/app/api/messages/bulk/types";
import type { Message } from "@/hooks/types";
import { setMessageDragData } from "@/lib/messages/drag-utils";
import { BulkMessageToolbar } from "./bulk-message-toolbar";
import { SwipeableRow } from "./swipeable-row";
import { MessageListRowActions } from "./message-list-row-actions";
import { dispatchMessageCountsDelta, toggleMessageStar } from "./message-list-row-actions-utils";
import { MessageNavigationProgress, useMessageNavigation } from "./message-navigation";
import { rememberOpenedUnreadMessage } from "./message-detail-navigation-utils";
import { useConversationView } from "./use-conversation-view";
import type { MessageFolderPageProps, MessageListRowProps, RowMessageAction } from "./types";
import {
	formatMessageListTimestamp,
	getPageRange,
	getMessageParty,
	getMessagePartyClassName,
	getMessagePreview,
	isMessageListRowUnread,
	formatEmailPageTitle,
	getMailboxAddress,
	runBulkMessageAction,
	emptyMessageFolder,
} from "./utils";
import {
	getEmptyFolderConfirmText,
	getEmptyFolderLabel,
	getPermanentDeleteConfirmText,
	supportsPermanentDelete,
} from "@/lib/messages/permanent-delete-utils";
import clsx from "clsx";

const pageSize = 25;

function MessageListRow({
	message,
	config,
	selected,
	active = false,
	compact = false,
	currentAccountName,
	onSelectedChange,
	onMessageAction,
	dragMessageIds,
}: MessageListRowProps) {
	const Icon = config.icon;
	const [read, setRead] = useState(message.read);
	const [threadUnread, setThreadUnread] = useState(message.threadUnread);
	const [starred, setStarred] = useState(message.starred);
	useEffect(() => setRead(message.read), [message.read]);
	useEffect(() => setThreadUnread(message.threadUnread), [message.threadUnread]);
	useEffect(() => setStarred(message.starred), [message.starred]);
	const rowMessage = { ...message, read, starred, threadUnread };
	const unread = isMessageListRowUnread(rowMessage);
	const draggable = config.folder === "inbox" && message.direction === "inbound";
	const party = getMessageParty(rowMessage, config.folder, currentAccountName);
	const preview = getMessagePreview(rowMessage, config.folder);
	const href = `${config.hrefPrefix}/${message.id}`;
	const navigation = useMessageNavigation(href, rowMessage);

	async function runRowAction(action: RowMessageAction) {
		const previousRead = read;
		const previousThreadUnread = threadUnread;
		const unreadDelta = action === "read" ? -1 : action === "unread" ? 1 : 0;
		if (action === "read") setRead(true);
		if (action === "unread") setRead(false);
		// Grouped rows derive their unread styling from the thread count, so it must change with the row.
		if (message.threadMessageIds) {
			if (action === "read") setThreadUnread(0);
			if (action === "unread") setThreadUnread(message.threadMessageIds.length);
		}
		if (unreadDelta) dispatchMessageCountsDelta({ inboxUnreadDelta: unreadDelta });
		try {
			await onMessageAction(message.id, action);
		} catch (error) {
			if (action === "read" || action === "unread") {
				setRead(previousRead);
				setThreadUnread(previousThreadUnread);
				if (unreadDelta) dispatchMessageCountsDelta({ inboxUnreadDelta: -unreadDelta });
			}
			throw error;
		}
	}

	const swipeable = compact && (config.folder === "inbox" || config.folder === "snoozed") && message.direction === "inbound";

	function onMessageNavigate(event: MouseEvent<HTMLAnchorElement>) {
		if (!read && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) {
			rememberOpenedUnreadMessage(message.id);
			const previousThreadUnread = threadUnread;
			setRead(true);
			if (previousThreadUnread !== undefined) setThreadUnread(Math.max(0, previousThreadUnread - 1));
			if (message.direction === "inbound") dispatchMessageCountsDelta({ inboxUnreadDelta: -1 });
			void runBulkMessageAction([message.id], "read", false).catch(() => {
				setRead(false);
				setThreadUnread(previousThreadUnread);
				if (message.direction === "inbound") dispatchMessageCountsDelta({ inboxUnreadDelta: 1 });
			});
		}
		navigation.onNavigate(event, !read);
	}

	if (compact && config.folder !== "drafts") {
		const compactRow = (
			<div
				className={`group grid grid-cols-[20px_minmax(0,1fr)] gap-3 border-l-2 px-4 py-3 transition-colors ${active
					? "border-l-blue-600 bg-blue-50"
					: selected
						? "border-l-transparent bg-neutral-50"
						: "border-l-transparent hover:bg-neutral-50"
					} ${draggable ? "cursor-grab active:cursor-grabbing" : ""}`}
				draggable={draggable}
				onDragStart={(event) => {
					if (!draggable) return;
					setMessageDragData(event.dataTransfer, { messageIds: dragMessageIds });
				}}
			>
				<MessageNavigationProgress progress={navigation.progress} />
				<Checkbox
					checked={selected}
					onChange={(event) => onSelectedChange(message.id, event.target.checked)}
					className="mt-1 h-4 w-4 rounded border-neutral-300"
					aria-label={`Select message from ${party}`}
				/>
				<Link href={href} onClick={onMessageNavigate} className="min-w-0">
					<span className="flex items-baseline justify-between gap-3">
						<span className={clsx(unread && "font-semibold",getMessagePartyClassName(rowMessage, config.folder))}>
							{party}

							{(message.threadCount ?? 1) > 1 && (
								<span className="ml-2 text-xs font-normal text-neutral-500">{message.threadCount}</span>
							)}
						</span>
						<span className={clsx(unread ?"font-medium":"text-neutral-400","shrink-0 text-[11px]")}>
							{formatMessageListTimestamp(message.createdAt)}
						</span>
					</span>
					<span
						className={`mt-1 block truncate text-sm ${unread ? "font-semibold text-neutral-900" : "text-neutral-700"
							}`}
					>
						<bdi>{message.subject ?? "(no subject)"}</bdi>
					</span>
					<span className="mt-0.5 block truncate text-xs leading-5 text-neutral-500">
						<bdi>{preview}</bdi>
					</span>
				</Link>
			</div>
		);
		if (!swipeable) return compactRow;
		return (
			<SwipeableRow
				startAction={{
					label: read ? "Mark unread" : "Mark read",
					icon: read ? Mail : MailOpen,
					className: "bg-blue-600",
					onTrigger: () => void runRowAction(read ? "unread" : "read").catch(() => undefined),
				}}
				endAction={{
					label: "Archive",
					icon: Archive,
					className: "bg-emerald-600",
					onTrigger: () => void runRowAction("archive").catch(() => undefined),
				}}
			>
				{compactRow}
			</SwipeableRow>
		);
	}

	const className =
		`group relative grid min-h-12 w-full grid-cols-[24px_32px_minmax(160px,260px)_1fr_auto] items-center gap-3 px-6 text-left text-sm hover:z-10 hover:bg-[#f2f6fc] hover:shadow-sm ${active || selected ? "bg-blue-50" : ""
		} ${draggable ? "cursor-grab active:cursor-grabbing" : ""}`;
	const content = (
		<>
			{config.folder === "inbox" && message.direction === "inbound" && (
				<Tooltip label={starred ? "Starred" : "Not starred"}>
					<Button
						type="button"
						variant="ghost"
						size="sm"
						onClick={(event) => {
							event.preventDefault();
							event.stopPropagation();
							void toggleMessageStar(message.id).then((result) => setStarred(result.starred));
						}}
						aria-label={starred ? "Starred" : "Not starred"}
					>
						<Icon className={`h-4 w-4 ${starred ? "fill-amber-400 text-amber-400" : "text-neutral-300"}`} />
					</Button>
				</Tooltip>
			)}
			{(config.folder !== "inbox" || message.direction !== "inbound") && (
				<Icon className="h-4 w-4 text-neutral-300" />
			)}
			<span className={clsx(unread && "font-semibold", getMessagePartyClassName(rowMessage, config.folder))}>
				{party}

				{(message.threadCount ?? 1) > 1 && (
					<span className="ml-2 text-xs text-neutral-500">{message.threadCount}</span>
				)}
			</span>
			<span className="truncate text-neutral-700">
				<span className={unread ? "font-semibold text-neutral-900" : ""}>
					<bdi>{rowMessage.subject ?? "(no subject)"}</bdi>
				</span>
				<span className="text-neutral-500"> - <bdi>{getMessagePreview(rowMessage, config.folder)}</bdi></span>
			</span>
			<time
				dateTime={message.createdAt}
				className={`min-w-[96px] whitespace-nowrap text-right text-xs group-hover:opacity-0 ${unread ? "font-semibold text-neutral-800" : "text-neutral-500"
					}`}
			>
				{formatMessageListTimestamp(message.createdAt)}
			</time>
		</>
	);

	if (config.folder === "drafts") {
		return (
			<div className={className}>
				<Checkbox
					checked={selected}
					onChange={(event) => onSelectedChange(message.id, event.target.checked)}
					className="h-4 w-4 rounded border-neutral-300"
					aria-label="Select message"
				/>
				<Link href={href} className="contents text-left">
					{content}
				</Link>
			</div>
		);
	}

	return (
		<div
			className={className}
			draggable={draggable}
			onDragStart={(event) => {
				if (!draggable) return;
				setMessageDragData(event.dataTransfer, { messageIds: dragMessageIds });
			}}
		>
			<MessageNavigationProgress progress={navigation.progress} />
			<Checkbox
				checked={selected}
				onChange={(event) => onSelectedChange(message.id, event.target.checked)}
				className="h-4 w-4 rounded border-neutral-300"
				aria-label="Select message"
			/>
			<Link href={href} onClick={onMessageNavigate} className="contents">
				{content}
			</Link>
			{(config.folder === "inbox" || config.folder === "snoozed") && message.direction === "inbound" && (
				<MessageListRowActions
					message={rowMessage}
					onAction={runRowAction}
				/>
			)}
		</div>
	);
}

export function MessageFolderPage({
	config,
	compact = false,
	selectedMessageId,
	selection,
}: MessageFolderPageProps) {
	const { selectedMailbox, isLoading: mailboxesLoading } = useSelectedMailbox();
	const { query } = useMailSearch();
	const isMobile = useIsMobile();
	const [offset, setOffset] = useState(0);
	const [internalSelectedMessages, setInternalSelectedMessages] = useState<
		Array<{ id: string; read: boolean }>
	>([]);
	const [pendingBulkAction, setPendingBulkAction] = useState(false);
	const [emptyingFolder, setEmptyingFolder] = useState(false);
	const [unreadOnly, setUnreadOnly] = useState(false);
	const [conversationView] = useConversationView();
	const grouped = conversationView && config.folder !== "drafts";
	const { messages, isLoading, total, limit, updateMessages } = useMessages(config.folder, selectedMailbox?.id, {
		query,
		limit: pageSize,
		offset,
		read: unreadOnly ? "unread" : "all",
		group: grouped ? "thread" : undefined,
	}, !mailboxesLoading, config.folderId);
	const { counts } = useMessageCounts(selectedMailbox?.id, !mailboxesLoading);
	usePageLoading(mailboxesLoading || isLoading);
	const headerIcons = config.headerIcons ?? [];
	const hasActiveFilters = !!query.trim();
	const folderCount = config.folderId
		? counts.customFolders[config.folderId]
		: counts.folders[config.folder];
	const titleTotal = folderCount?.total ?? total;
	const titleUnread = folderCount?.unread ?? 0;
	const mailboxAddress = getMailboxAddress(selectedMailbox);
	const currentAccountName = selectedMailbox?.displayName ?? selectedMailbox?.localPart;
	const pageRange = getPageRange(offset, messages.length, total);
	const selectedMessages = selection?.selectedMessages ?? internalSelectedMessages;
	const setSelectedMessages =
		selection?.setSelectedMessages ?? setInternalSelectedMessages;
	const selectedIds = useMemo(
		() => selectedMessages.map((message) => message.id),
		[selectedMessages],
	);
	const hasUnreadSelection = selectedMessages.some((message) => !message.read);
	const allVisibleSelected = messages.length > 0 && messages.every((message) => selectedIds.includes(message.id));
	// In conversation view a row stands for every message of its thread in this
	// folder, so actions and drags carry all of them.
	const rowMessageIds = (message: Message) => message.threadMessageIds ?? [message.id];
	const expandSelectedIds = (ids: string[]) =>
		ids.flatMap((id) => rowMessageIds(messages.find((message) => message.id === id) ?? { id } as Message));

	useEffect(() => {
		setOffset(0);
		setSelectedMessages([]);
	}, [query, selectedMailbox?.id, config.folder, config.folderId, unreadOnly, grouped]);

	useEffect(() => {
		setSelectedMessages([]);
	}, [offset]);

	useEffect(() => {
		if (mailboxesLoading) return;
		document.title = formatEmailPageTitle({
			location: config.title,
			total: titleTotal,
			unread: titleUnread,
			emailAddress: mailboxAddress,
		});
	}, [config.title, mailboxAddress, mailboxesLoading, titleTotal, titleUnread]);

	function updateSelectedMessage(messageId: string, selected: boolean) {
		const message = messages.find((item) => item.id === messageId);
		if (!message) return;

		setSelectedMessages((current) => {
			if (!selected) return current.filter((item) => item.id !== messageId);
			if (current.some((item) => item.id === messageId)) return current;
			return [...current, { id: message.id, read: message.read && !(message.threadUnread ?? 0) }];
		});
	}

	function toggleAllVisible(selected: boolean) {
		const visibleIds = new Set(messages.map((message) => message.id));
		setSelectedMessages((current) => {
			if (!selected) {
				return current.filter((message) => !visibleIds.has(message.id));
			}

			const next = new Map(current.map((message) => [message.id, message]));
			for (const message of messages) {
				next.set(message.id, { id: message.id, read: message.read && !(message.threadUnread ?? 0) });
			}
			return Array.from(next.values());
		});
	}

	const permanentDeleteFolder = !config.folderId && supportsPermanentDelete(config.folder) ? config.folder : null;
	async function emptyFolder() {
		if (!permanentDeleteFolder || !selectedMailbox?.id) return;
		if (!window.confirm(getEmptyFolderConfirmText(permanentDeleteFolder, titleTotal))) return;
		setEmptyingFolder(true);
		try {
			await emptyMessageFolder(selectedMailbox.id, permanentDeleteFolder);
			setOffset(0);
		} catch (error) {
			console.error(error);
			window.alert(`Could not empty ${permanentDeleteFolder === "trash" ? "Trash" : "Spam"}. Please try again.`);
		} finally {
			setEmptyingFolder(false);
		}
	}

	async function runSelectedAction(action: BulkMessageAction, folderId?: string) {
		if (selectedIds.length === 0) return;
		if (action === "delete") {
			const ids = expandSelectedIds(selectedIds);
			if (!window.confirm(getPermanentDeleteConfirmText(ids.length))) return;
		}

		setPendingBulkAction(true);
		const previousMessages = messages;
		const readValue = action === "read" ? true : action === "unread" ? false : null;
		const changedMessages = readValue === null
			? []
			: messages.filter((message) => selectedIds.includes(message.id) && message.read !== readValue);
		if (readValue !== null) {
			updateMessages((current) => current.map((message) =>
				selectedIds.includes(message.id) ? { ...message, read: readValue } : message,
			));
			setSelectedMessages((current) => current.map((message) => ({ ...message, read: readValue })));
			const inboxUnreadDelta = changedMessages
				.filter((message) => message.direction === "inbound")
				.reduce((total, message) => total + (readValue ? (message.read ? 0 : -1) : (message.read ? 1 : 0)), 0);
			if (inboxUnreadDelta) dispatchMessageCountsDelta({ inboxUnreadDelta });
		}
		try {
			await runBulkMessageAction(expandSelectedIds(selectedIds), action, true, folderId);
			setSelectedMessages([]);
		} catch (error) {
			if (readValue !== null) {
				updateMessages(previousMessages);
				const inboxUnreadDelta = changedMessages
					.filter((message) => message.direction === "inbound")
					.reduce((total, message) => total + (readValue ? (message.read ? 0 : 1) : (message.read ? -1 : 0)), 0);
				if (inboxUnreadDelta) dispatchMessageCountsDelta({ inboxUnreadDelta });
			}
			throw error;
		} finally {
			setPendingBulkAction(false);
		}
	}

	return (
		<div className="flex h-full min-h-0 flex-col">
			<div className={`flex h-14 shrink-0 items-center justify-between border-b border-neutral-200 ${compact ? "px-4" : "px-4.5 md:px-6"}`}>
				<div className="flex items-center gap-3 w-full">
					<Tooltip label="Select all visible messages">
						<Checkbox
							checked={allVisibleSelected}
							disabled={messages.length === 0}
							onChange={(event) => toggleAllVisible(event.target.checked)}
							className="h-4 w-4 rounded border-neutral-300"
							aria-label="Select all visible messages"
						/>
					</Tooltip>
					{selectedIds.length > 0 && !compact ? (
						<BulkMessageToolbar
							selectedCount={selectedIds.length}
							hasUnreadSelection={hasUnreadSelection}
							onAction={runSelectedAction}
							onClearSelection={() => setSelectedMessages([])}
							pending={pendingBulkAction}
							folder={config.folderId ? undefined : config.folder}
						/>
					) : (
						(compact || isMobile) && (
							<h1 className="truncate font-semibold text-neutral-900 pl-1">{config.title}</h1>
						)
					)}
				</div>
				{(selectedIds.length === 0 || compact) && (
					<div className="flex items-center gap-2 text-neutral-500">
						<span className="text-xs text-neutral-500 whitespace-nowrap">
							{pageRange.start} - {pageRange.end} of {pageRange.total}
						</span>
						<Tooltip label="Previous page">
							<Button
								variant="ghost"
								size="sm"
								disabled={offset === 0 || isLoading}
								onClick={() => setOffset(Math.max(offset - limit, 0))}
								aria-label="Previous page"
							>
								<ChevronLeft className="h-4 w-4" />
							</Button>
						</Tooltip>
						<Tooltip label="Next page">
							<Button
								variant="ghost"
								size="sm"
								disabled={offset + messages.length >= total || isLoading}
								onClick={() => setOffset(offset + limit)}
								aria-label="Next page"
							>
								<ChevronRight className="h-4 w-4" />
							</Button>
						</Tooltip>
						{config.folder === "inbox" && (
							<Tooltip label={unreadOnly ? "Showing unread emails" : "Show unread emails only"}>
								<Button
									type="button"
									variant="ghost"
									size="sm"
									aria-label="Show unread emails only"
									aria-pressed={unreadOnly}
									onClick={() => setUnreadOnly((current) => !current)}
									className={unreadOnly ? "bg-blue-100 text-blue-700 hover:bg-blue-100" : undefined}
								>
									<ListFilter className="h-4 w-4" />
								</Button>
							</Tooltip>
						)}
						{permanentDeleteFolder && (
							<Tooltip label={getEmptyFolderLabel(permanentDeleteFolder)}>
								<Button
									type="button"
									variant="ghost"
									size="sm"
									aria-label={getEmptyFolderLabel(permanentDeleteFolder)}
									disabled={emptyingFolder || isLoading || total === 0}
									onClick={() => void emptyFolder()}
									className="gap-1.5 text-xs font-medium text-red-600 hover:text-red-700"
								>
									<Trash2 className="h-4 w-4" />
									{!compact && <span className="max-md:hidden">{emptyingFolder ? "Emptying…" : getEmptyFolderLabel(permanentDeleteFolder)}</span>}
								</Button>
							</Tooltip>
						)}
						{!compact && headerIcons.map((Icon, index) => (
							<Icon key={index} className="h-4 w-4" />
						))}
					</div>
				)}
			</div>

			<div className="min-h-0 flex-1 divide-y divide-neutral-100 overflow-y-auto overscroll-contain scrollbar-gutter-stable">
				{messages.map((message) => (
					<MessageListRow
						key={message.id}
						message={message}
						config={config}
						selected={selectedIds.includes(message.id)}
						active={message.id === selectedMessageId}
						compact={compact || isMobile}
						currentAccountName={currentAccountName}
						onSelectedChange={updateSelectedMessage}
						onMessageAction={(messageId, action) =>
							runBulkMessageAction(expandSelectedIds([messageId]), action, action !== "read" && action !== "unread")
						}
						dragMessageIds={expandSelectedIds(selectedIds.includes(message.id) ? selectedIds : [message.id])}
					/>
				))}
				{!isLoading && messages.length === 0 && (
					<p className="px-6 py-4 text-sm text-neutral-500">
						{hasActiveFilters ? "No messages match these filters" : config.emptyText}
					</p>
				)}
			</div>
		</div>
	);
}

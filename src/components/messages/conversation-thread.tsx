"use client";

import { useEffect, useState } from "react";
import dayjs from "dayjs";
import { ChevronsUpDown, Paperclip } from "lucide-react";
import { ContactAvatar } from "@/components/contacts/contact-avatar";
import { QuotedEmailToggle } from "@/components/messages/quoted-email-toggle";
import { runSingleMessageAction } from "@/components/message-actions/utils";
import { sanitizeEmailHtml } from "@/app/(dashboard)/inbox/[messageId]/email-html-sanitizer";
import { collapseQuotedEmailHtml } from "@/app/(dashboard)/inbox/[messageId]/quote-collapse-utils";
import { getMessageBodyDisplay, resolveInlineAttachmentUrls } from "@/app/(dashboard)/inbox/[messageId]/utils";

import { cn } from "@/lib/utils";
import type { ConversationMessageCardProps, ConversationThreadProps } from "./conversation-thread-types";
import { ThreadMessageActions } from "./thread-message-actions";
import {
	getConversationRecipients,
	getConversationSender,
	getConversationSenderEmail,
	partitionThread,
} from "./conversation-thread-utils";
import clsx from "clsx";

/**
 * The other messages in a conversation, ordered oldest to newest and collapsed
 * until opened. Readers can also expand the full visible portion at once.
 */
export function ConversationThread({
	currentMessageId,
	position,
	messages,
	mailboxId,
	currentAccountName,
	ownAddress,
	ownAddresses,
	latestMessagesFirst,
	expandedAll,
	onExpandedAllChange,
}: ConversationThreadProps) {
	const slice = partitionThread(messages, currentMessageId, position, latestMessagesFirst);
	if (slice.length === 0) return null;
	const firstMessage = slice[0];
	const lastMessage = slice.at(-1)!;
	const middleMessages = slice.slice(1, -1);
	const collapsed = !expandedAll && middleMessages.length > 0;
	const collapsedLabel = `${middleMessages.length} ${position === "before" ? "older" : "newer"} message${middleMessages.length === 1 ? "" : "s"}`;

	return (
		<section
			aria-label={position === "before" ? "Earlier messages in this conversation" : "Later messages in this conversation"}
			className={cn(position === (latestMessagesFirst ? "before" : "after") ? "pb-6" : "")}
		>
			<ol className={cn(!collapsed && "divide-y divide-neutral-200/50", latestMessagesFirst ? "border-y" : "border-b", "border-neutral-200")}>
				<li className={"border-t-0" }>
					<ConversationMessageCard
						message={firstMessage}
						mailboxId={mailboxId}
						currentAccountName={currentAccountName}
						ownAddress={ownAddress}
						ownAddresses={ownAddresses}
					/>
				</li>
				{collapsed ? (
					<li className="flex items-center justify-center gap-1 py-2 text-center border-y border-neutral-100 h-px my-4">
						<span className="bg-white px-6 flex flex-row items-center gap-2">
							<span className="text-sm font-medium text-neutral-600">{collapsedLabel}</span>
							<button
								type="button"
								onClick={() => onExpandedAllChange(true)}
								aria-label={`Expand ${collapsedLabel}`}
								title={`Expand ${collapsedLabel}`}
								className="inline-flex h-6 w-6 items-center justify-center rounded-full text-neutral-500 hover:bg-neutral-100 hover:text-neutral-900"
							>
								<ChevronsUpDown className="h-4 w-4" />
							</button>
						</span>
					</li>
				) : (
					middleMessages.map((message) => (
						<li key={message.id}>
							<ConversationMessageCard
								message={message}
								mailboxId={mailboxId}
								currentAccountName={currentAccountName}
								ownAddress={ownAddress}
								ownAddresses={ownAddresses}
							/>
						</li>
					))
				)}
				{lastMessage.id !== firstMessage.id && (
					<li>
						<ConversationMessageCard
							message={lastMessage}
							mailboxId={mailboxId}
							currentAccountName={currentAccountName}
							ownAddress={ownAddress}
							ownAddresses={ownAddresses}
						/>
					</li>
				)}
			</ol>
		</section>
	);
}

export function ConversationMessageCard({
	message,
	mailboxId,
	currentAccountName,
	ownAddress,
	ownAddresses,
	defaultExpanded = false,
}: ConversationMessageCardProps) {
	const [locallyExpanded, setLocallyExpanded] = useState(defaultExpanded);
	const [locallyRead, setLocallyRead] = useState(message.read);
	const expanded = locallyExpanded;
	const sender = getConversationSender(message, currentAccountName);
	const senderEmail = getConversationSenderEmail(message);
	const recipients = getConversationRecipients(message);
	// const href = `${getMessageBackHref(message.direction, message.status)}/${message.id}`;
	const outbound = message.direction === "outbound";
	const attachments = message.attachments.filter((attachment) => attachment.disposition === "attachment");

	useEffect(() => setLocallyRead(message.read), [message.read]);

	let body: { html: string | null; text: string; quotedHtml: string | null } | null = null;
	if (expanded) {
		const display = getMessageBodyDisplay(message.textBody, message.htmlBody, message.snippet);
		body = {
			html: collapseQuotedEmailHtml(sanitizeEmailHtml(resolveInlineAttachmentUrls(display.htmlBody, message.id, message.attachments))),
			text: display.latestContent,
			quotedHtml: collapseQuotedEmailHtml(sanitizeEmailHtml(resolveInlineAttachmentUrls(display.quotedHtml, message.id, message.attachments)), true),
		};
	}

	return (
		<article className={cn("bg-white transition-colors px-6", !expanded && "hover:bg-neutral-50")}>
			<div className="flex w-full flex-wrap items-start gap-x-3 py-3">
				<button
					type="button"
					onClick={() => {
						const shouldExpand = !locallyExpanded;
						setLocallyExpanded(shouldExpand);
						if (!shouldExpand || locallyRead) return;
						setLocallyRead(true);
						void runSingleMessageAction(message.id, "read").catch(() => setLocallyRead(false));
					}}
					aria-expanded={expanded}
					className="flex min-w-0 flex-1 basis-40 items-center gap-3 text-left cursor-pointer"
				>
					<ContactAvatar
						mailboxId={mailboxId}
						address={message.fromAddr}
						name={sender}
						hasManagedAvatar={message.fromContactHasAvatar}
						managedAvatarUrl={outbound && mailboxId ? `/api/mailboxes/${mailboxId}/avatar` : undefined}
						className={expanded ? "mt-1" : ""}
					/>
					<span className="min-w-0 flex-1">
						<div className="flex flex-col">
							<span className={cn("truncate text-sm font-semibold mt-1", locallyRead || outbound ? "text-neutral-900" : "font-semibold text-neutral-900")}>
								{sender}
								{expanded && <span className="text-xs ml-1 opacity-50 font-normal">&lt;{senderEmail}&gt;</span>}
							</span>
							{expanded && recipients && <span className="text-xs font-normal text-neutral-500">to {recipients}</span>}
						</div>
						{!expanded && (
							<span className={clsx( !locallyRead ? "font-semibold" : "text-neutral-500", "block truncate text-[13px]")}>{message.snippet || "No preview"}</span>
						)}
					</span>
				</button>
				<span className="flex shrink-0 items-center gap-2 text-xs mr-2 mt-2">
					{attachments.length > 0 && <Paperclip className="h-3.5 w-3.5" aria-label={`${attachments.length} attachments`} />}
					{dayjs(message.createdAt).format("MMM DD, YYYY, hh:mmA")}
				</span>
				<ThreadMessageActions
					message={message}
					mailboxId={mailboxId}
					ownAddress={ownAddress}
					ownAddresses={ownAddresses}
				/>
			</div>
			{expanded && body && (
				<div className="pb-4 pt-2">
					{body.html ? (
						<div className="email-body max-w-none text-sm text-neutral-900" dangerouslySetInnerHTML={{ __html: body.html }} />
					) : (
						<pre className="whitespace-pre-wrap font-sans text-sm text-neutral-900">{body.text}</pre>
					)}
					{body.quotedHtml && <QuotedEmailToggle html={body.quotedHtml} />}
					{attachments.length > 0 && (
						<ul className="mt-4 flex flex-wrap gap-2">
							{attachments.map((attachment) => (
								<li key={attachment.id}>
									<a
										href={`/api/messages/${message.id}/attachments/${attachment.id}`}
										className="inline-flex items-center gap-1.5 rounded-md border border-neutral-200 bg-white px-2.5 py-1 text-xs text-neutral-700 hover:bg-neutral-50"
									>
										<Paperclip className="h-3 w-3" />
										<span className="max-w-48 truncate">{attachment.filename}</span>
									</a>
								</li>
							))}
						</ul>
					)}
				</div>
			)}
		</article>
	);
}

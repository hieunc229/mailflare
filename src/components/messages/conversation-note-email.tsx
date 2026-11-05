"use client";

import Link from "next/link";
import { ContactAvatar } from "@/components/contacts/contact-avatar";
import { X } from "@/components/icons";
import { useLanguage } from "@/components/language-provider";
import { formatUserDate } from "@/lib/time/utils";
import { cn } from "@/lib/utils";
import { getConversationSender } from "./conversation-thread-utils";
import type { ConversationNoteEmailProps } from "./conversation-notes-types";

/**
 * An email attached to a note: sender, subject and the first line of the body,
 * with its date at the top right. Opens that email in the thread when clicked.
 */
export function ConversationNoteEmail({ message, mailboxId, currentAccountName, onRemove, className }: ConversationNoteEmailProps) {
	const { t } = useLanguage();
	if (!message) {
		return <p className={cn("rounded-lg border border-dashed border-neutral-200 px-3 py-2 text-xs text-neutral-500", className)}>{t("note.emailUnavailable")}</p>;
	}
	const sender = getConversationSender(message, currentAccountName);
	const outbound = message.direction === "outbound";
	const card = (
		<>
			<div className="flex items-center gap-1.5">
				<ContactAvatar
					mailboxId={mailboxId}
					address={message.fromAddr}
					name={sender}
					hasManagedAvatar={message.fromContactHasAvatar}
					managedAvatarUrl={outbound && mailboxId ? `/api/mailboxes/${mailboxId}/avatar` : undefined}
					className="h-4 w-4 text-[9px]"
				/>
				<span className="min-w-0 flex-1 truncate text-xs font-semibold text-neutral-900">{sender}</span>
				<time dateTime={message.createdAt} className={cn("shrink-0 text-[11px] text-neutral-500", onRemove && "mr-5")}>
					{formatUserDate(message.createdAt, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
				</time>
			</div>
			<p className="mt-1 truncate text-xs font-medium text-neutral-800">{message.subject || t("list.noSubject")}</p>
			<p className="truncate text-xs text-neutral-500">{message.snippet || t("thread.noPreview")}</p>
		</>
	);
	const boxClass = cn("relative block rounded-lg border border-neutral-200 bg-neutral-50 px-3 py-2", className);
	return (
		<div className="relative">
			<Link href={`/inbox/${message.id}`} className={cn(boxClass, "hover:bg-neutral-100")}>{card}</Link>
			{onRemove && (
				<button
					type="button"
					onClick={onRemove}
					aria-label={t("note.removeEmail")}
					className="absolute right-1.5 top-1.5 flex h-5 w-5 items-center justify-center rounded text-neutral-500 hover:bg-neutral-200 hover:text-neutral-900"
				>
					<X className="h-3.5 w-3.5" />
				</button>
			)}
		</div>
	);
}

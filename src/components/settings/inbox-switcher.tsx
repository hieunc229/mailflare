"use client";

import { useRef, useState } from "react";
import { Check, ChevronDown, UsersRound } from "@/components/icons";
import { useDismissible } from "@/components/use-dismissible";
import { useLanguage } from "@/components/language-provider";
import { useSelectedMailbox, type MailboxOption } from "@/components/mailbox-provider";
import { ProgressiveAvatarImage } from "@/components/progressive-avatar-image";
import { getAccountInitial, getMailboxAddress, getMailboxName } from "@/components/mailbox-selector-utils";
import { getAvatarColorStyle } from "@/lib/avatar-colors";

function InboxAvatar({ mailbox }: { mailbox: MailboxOption }) {
	const name = getMailboxName(mailbox);
	const [failedId, setFailedId] = useState<string | null>(null);

	if (mailbox.hasAvatar && failedId !== mailbox.id) {
		return (
			<ProgressiveAvatarImage
				src={`/api/mailboxes/${mailbox.id}/avatar`}
				alt={name}
				className="h-10 w-10 shrink-0 rounded-full border border-neutral-200 object-cover"
				onError={() => setFailedId(mailbox.id)}
			/>
		);
	}

	return (
		<div
			className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-blue-600 text-sm font-semibold text-white"
			style={getAvatarColorStyle(getMailboxAddress(mailbox))}
			aria-hidden="true"
		>
			{getAccountInitial(name)}
		</div>
	);
}

function InboxLabel({ mailbox }: { mailbox: MailboxOption }) {
	const { t } = useLanguage();
	return (
		<>
			<InboxAvatar mailbox={mailbox} />
			<div className="min-w-0 flex-1 text-left">
				<div className="flex items-center gap-1.5">
					<p className="truncate text-sm font-semibold text-neutral-900">{getMailboxName(mailbox)}</p>
					{mailbox.type === "shared" && (
						<span title={t("account.sharedInbox")} aria-label={t("account.sharedInbox")} className="shrink-0 text-blue-600">
							<UsersRound className="h-3.5 w-3.5" />
						</span>
					)}
				</div>
				<p className="truncate text-xs text-neutral-500">{getMailboxAddress(mailbox)}</p>
			</div>
		</>
	);
}

export function InboxSwitcher() {
	const { t } = useLanguage();
	const { selectedMailbox, setSelectedMailbox, mailboxes } = useSelectedMailbox();
	const [open, setOpen] = useState(false);
	const ref = useRef<HTMLDivElement>(null);

	useDismissible(open, () => setOpen(false), ref);

	if (!selectedMailbox) return null;

	return (
		<div ref={ref} className="relative">
			<button
				type="button"
				onClick={() => setOpen((value) => !value)}
				aria-expanded={open}
				aria-haspopup="listbox"
				aria-label={t("settings.account.switchInbox")}
				className="flex w-full items-center gap-3 rounded-2xl border border-neutral-200 px-4 py-3 transition-colors hover:bg-neutral-50"
			>
				<InboxLabel mailbox={selectedMailbox} />
				<ChevronDown className={`h-4 w-4 shrink-0 text-neutral-500 transition-transform ${open ? "rotate-180" : ""}`} />
			</button>
			{open && (
				<div
					role="listbox"
					className="absolute left-0 right-0 top-full z-50 mt-2 max-h-72 overflow-y-auto rounded-2xl border border-neutral-200 bg-white p-1 shadow-xl shadow-neutral-900/10"
				>
					{mailboxes.map((mailbox) => {
						const selected = mailbox.id === selectedMailbox.id;
						return (
							<button
								key={mailbox.id}
								type="button"
								role="option"
								aria-selected={selected}
								onClick={() => {
									setSelectedMailbox(mailbox);
									setOpen(false);
								}}
								className="flex w-full items-center gap-3 rounded-xl px-3 py-2 hover:bg-neutral-100"
							>
								<InboxLabel mailbox={mailbox} />
								{selected && <Check className="h-4 w-4 shrink-0 text-blue-600" />}
							</button>
						);
					})}
				</div>
			)}
		</div>
	);
}

"use client";

import { Ban, MailPlus, Pencil, Trash2 } from "@/components/icons";
import { useLanguage } from "@/components/language-provider";
import { Button } from "@/components/ui/button";
import { formatUserDate } from "@/lib/time/utils";
import { ContactAvatar } from "./contact-avatar";
import type { ContactRowProps } from "./contacts-page-types";

export function ContactRow({ mailboxId, contact, onEmail, onEdit, onDelete }: ContactRowProps) {
	const { t } = useLanguage();
	const label = contact.displayName ?? contact.email;

	return (
		<div className="group flex items-center gap-3 rounded-xl px-3 py-2.5 transition-colors hover:bg-neutral-50">
			<ContactAvatar
				mailboxId={mailboxId}
				address={contact.email}
				name={contact.displayName ?? ""}
				hasManagedAvatar={contact.hasAvatar}
			/>
			<div className="min-w-0 flex-1">
				<p className="flex items-center gap-2 truncate text-sm font-medium text-neutral-900">
					<span className="truncate">{label}</span>
					{contact.blocked && (
						<span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-red-50 px-2 py-0.5 text-xs font-medium text-red-700">
							<Ban className="h-3 w-3" />
							{t("contact.blocked")}
						</span>
					)}
				</p>
				<p className="truncate text-xs text-neutral-500">
					{contact.displayName ? contact.email : ""}
					{contact.lastSeenAt
						? `${contact.displayName ? " · " : ""}${t("contact.lastSeen")} ${formatUserDate(contact.lastSeenAt, { month: "short", day: "numeric", year: "numeric" })}`
						: ""}
				</p>
			</div>
			<div className="flex shrink-0 items-center gap-1 max-sm:opacity-100 sm:opacity-0 sm:transition-opacity sm:group-hover:opacity-100 sm:group-focus-within:opacity-100">
				<Button
					type="button"
					variant="ghost"
					size="sm"
					onClick={() => onEmail(contact)}
					aria-label={t("contacts.sendEmail", { name: label })}
					title={t("contacts.sendEmail", { name: label })}
				>
					<MailPlus className="h-4 w-4" />
				</Button>
				<Button
					type="button"
					variant="ghost"
					size="sm"
					onClick={() => onEdit(contact)}
					aria-label={t("contacts.edit")}
					title={t("contacts.edit")}
				>
					<Pencil className="h-4 w-4" />
				</Button>
				<Button
					type="button"
					variant="ghost"
					size="sm"
					onClick={() => onDelete(contact)}
					aria-label={t("contacts.delete")}
					title={t("contacts.delete")}
					className="hover:text-red-600"
				>
					<Trash2 className="h-4 w-4" />
				</Button>
			</div>
		</div>
	);
}

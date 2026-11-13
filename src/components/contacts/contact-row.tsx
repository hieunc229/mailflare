"use client";

import { Ban, Edit04, MailSend01, Trash2 } from "@/components/icons";
import { useLanguage } from "@/components/language-provider";
import { Button } from "@/components/ui/button";
import { ListRow } from "@/components/ui/list";
import { Tooltip } from "@/components/ui/tooltip";
import { formatUserDate } from "@/lib/time/utils";
import { ContactAvatar } from "./contact-avatar";
import type { ContactRowProps } from "./contacts-page-types";
import { CONTACT_COLUMNS } from "./contacts-page-utils";

export function ContactRow({ mailboxId, contact, onEmail, onEdit, onDelete }: ContactRowProps) {
	const { t } = useLanguage();
	const label = contact.displayName ?? contact.email;

	return (
		<ListRow className={`${CONTACT_COLUMNS} group px-5 py-4 transition-colors hover:bg-blue-50/40`}>
			<ContactAvatar
				mailboxId={mailboxId}
				address={contact.email}
				name={contact.displayName ?? ""}
				hasManagedAvatar={contact.hasAvatar}
			/>
			<div className="min-w-0">
				<p className="flex items-center gap-2 truncate text-sm font-semibold text-neutral-900">
					<span className="truncate">{label}</span>
					{contact.blocked && (
						<span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-red-50 px-2 py-0.5 text-xs font-medium text-red-700">
							<Ban className="h-3 w-3" />
							{t("contact.blocked")}
						</span>
					)}
				</p>
				{contact.displayName && <p className="truncate no-font-mono text-sm text-neutral-500">{contact.email}</p>}
			</div>
			<span className="hidden text-sm text-neutral-500 md:block">
				{contact.lastSeenAt
					? formatUserDate(contact.lastSeenAt, { month: "short", day: "numeric", year: "numeric" })
					: "—"}
			</span>
			<div className="flex shrink-0 items-center gap-1 max-sm:opacity-100 sm:opacity-0 sm:transition-opacity sm:group-hover:opacity-100 sm:group-focus-within:opacity-100">
				<Tooltip label={t("contacts.sendEmail", { name: label })}>
					<Button
						type="button"
						variant="ghost"
						size="sm"
						onClick={() => onEmail(contact)}
						aria-label={t("contacts.sendEmail", { name: label })}
					>
						<MailSend01 className="h-4 w-4" />
					</Button>
				</Tooltip>
				<Tooltip label={t("contacts.edit")}>
					<Button
						type="button"
						variant="ghost"
						size="sm"
						onClick={() => onEdit(contact)}
						aria-label={t("contacts.edit")}
					>
						<Edit04 className="h-4 w-4" />
					</Button>
				</Tooltip>
				<Tooltip label={t("contacts.delete")}>
					<Button
						type="button"
						variant="ghost"
						size="sm"
						onClick={() => onDelete(contact)}
						aria-label={t("contacts.delete")}
						className="hover:text-red-600"
					>
						<Trash2 className="h-4 w-4" />
					</Button>
				</Tooltip>
			</div>
		</ListRow>
	);
}

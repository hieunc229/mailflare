"use client";

import { useLanguage } from "@/components/language-provider";
import { getRecipientTagFromList } from "@/lib/email/recipient-tag";
import { cn } from "@/lib/utils";

/**
 * The `+tag` in the message's To header, shown as a chip where a recipient or
 * subject line already renders. The header can differ from the SMTP envelope
 * recipient (e.g. Bcc, lists), so this labels the address, not the delivery.
 * Nothing renders when no recipient carries a tag.
 */
export function RecipientTagBadge({ toAddr, className }: { toAddr: string; className?: string }) {
	const { t } = useLanguage();
	const tag = getRecipientTagFromList(toAddr);
	if (!tag) return null;
	return (
		<span
			role="img"
			aria-label={t("message.recipientTag", { tag })}
			title={t("message.recipientTag", { tag })}
			className={cn(
				"inline-flex shrink-0 items-center rounded-full bg-neutral-100 px-2 py-0.5 text-[11px] font-medium leading-4 text-neutral-600",
				className,
			)}
		>
			+{tag}
		</span>
	);
}

"use client";

import { ChevronDown, ShieldAlert } from "@/components/icons";
import { useLanguage } from "@/components/language-provider";
import { cn } from "@/lib/utils";
import type { TranslationKey } from "@/lib/i18n/types";
import { getSenderWarning, type SenderWarningReason } from "./message-details-utils";
import { useMessageAuthentication } from "./use-message-authentication";
import type { SenderCheckBadgeProps, SenderCheckNoticeProps } from "./sender-check-types";

const reasonKeys: Record<SenderWarningReason, TranslationKey> = {
	authentication: "message.senderCheckAuthenticationFailed",
	senderName: "message.detailsSenderWarning",
	domain: "message.detailsDomainMismatch",
	replyTo: "message.detailsReplyToWarning",
};

/** Compact warning for a collapsed thread card. */
export function SenderCheckBadge({ message, className }: SenderCheckBadgeProps) {
	const { t } = useLanguage();
	const { authentication } = useMessageAuthentication(message.id, message.direction);
	const warning = getSenderWarning(message, authentication);
	if (!warning) return null;
	return (
		<span
			title={warning.reasons.map((reason) => t(reasonKeys[reason])).join(" ")}
			className={cn("mt-1 inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-medium text-amber-800", className)}
		>
			<ShieldAlert className="h-3 w-3 shrink-0" aria-hidden="true" />
			{t("message.senderCheckShort")}
		</span>
	);
}

/** Keep the live region mounted so late authentication warnings are announced. */
export function SenderCheckNotice({
	message,
	detailsOpen = false,
	onViewDetails,
	announce = false,
	className,
}: SenderCheckNoticeProps) {
	const { t } = useLanguage();
	const { authentication } = useMessageAuthentication(message.id, message.direction);
	const warning = getSenderWarning(message, authentication);

	return (
		<div role={announce ? "status" : undefined} className={warning ? className : undefined}>
			{warning && (
				<button
					type="button"
					onClick={onViewDetails}
					aria-expanded={detailsOpen}
					aria-label={t("message.senderCheckTitle")}
					className={cn(
						"flex w-full items-center gap-2 rounded-xl border px-3 py-2 text-left text-[13px] font-medium transition-colors",
						"focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-600",
						detailsOpen
							? "border-amber-300 bg-amber-100 text-amber-950 hover:bg-amber-200/40"
							: "border-amber-200/80 bg-amber-50/70 text-amber-900 hover:bg-amber-100/70",
					)}
				>
					<ShieldAlert className="h-4 w-4 shrink-0 text-amber-700" aria-hidden="true" />
					<span className="min-w-0 flex-1 break-words">{t("message.senderCheckTitle")}</span>
					<ChevronDown
						aria-hidden="true"
						className={cn("h-4 w-4 shrink-0 transition-transform", detailsOpen && "rotate-180")}
					/>
				</button>
			)}
		</div>
	);
}

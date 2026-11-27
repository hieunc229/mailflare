"use client";

import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { useState, type ReactNode } from "react";
import { AlertTriangle, ChevronDown, ExternalLink, ShieldAlert } from "@/components/icons";
import { useLanguage } from "@/components/language-provider";
import { splitEmailAddressList } from "@/lib/email/address";
import { formatRecipientAddressList } from "@/lib/email/recipient-display";
import { formatUserDate } from "@/lib/time/utils";
import { cn } from "@/lib/utils";
import { MessageSourceDialog } from "./message-source-dialog";
import type { MessageDetailsPopoverProps } from "./message-details-types";
import { useMessageAuthentication } from "./use-message-authentication";
import {
	getOriginalSender,
	getReplyToEntries,
	hasDomainMismatchWarning,
	hasFailingAuthenticationCheck,
	hasSenderNameAddressMismatch,
	isReplyToDifferent,
} from "./message-details-utils";

function DetailRow({ label, children, warning }: { label: string; children: ReactNode; warning?: string | null }) {
	return (
		<div className="grid grid-cols-[84px_minmax(0,1fr)] gap-3">
			<dt className="text-right lowercase text-neutral-500">{label}:</dt>
			<dd className="min-w-0 break-words text-neutral-900">
				{children}
				{warning && (
					<span className="mt-0.5 flex items-start gap-1 text-amber-700">
						<AlertTriangle className="mt-px h-3 w-3 shrink-0" aria-hidden="true" />
						<span>{warning}</span>
					</span>
				)}
			</dd>
		</div>
	);
}

function statusTone(status: string | undefined): string {
	if (status === "PASS") return "text-green-700";
	if (status === "FAIL" || status === "SOFTFAIL" || status === "PERMERROR") return "text-red-700";
	if (status === "TEMPERROR" || status === "NEUTRAL" || status === "NONE") return "text-amber-700";
	return "text-neutral-800";
}

/** Mounted only while the popup is open, so authentication loads on demand. */
function MessageDetails({ message }: Pick<MessageDetailsPopoverProps, "message">) {
	const { t } = useLanguage();
	const { authentication, failed: authenticationFailed, loading } = useMessageAuthentication(message.id, message.direction);
	const original = getOriginalSender(message.fromAddr);
	const contactName = message.fromContactName?.trim();
	const showContactName = message.direction === "inbound" && !!contactName && contactName !== original.name;
	const replyToEntries = getReplyToEntries(message.replyTo);
	const results = authentication?.available ? authentication : null;

	return (
		<dl className="space-y-2">
			<DetailRow
				label={t("source.from")}
				warning={hasSenderNameAddressMismatch(message) ? t("message.detailsSenderWarning") : null}
			>
				{original.name ? (
					<>
						<span className="font-semibold">{original.name}</span>{" "}
						<span className="text-neutral-500">&lt;{original.address}&gt;</span>
					</>
				) : original.address}
			</DetailRow>
			{showContactName && <DetailRow label={t("message.detailsContact")}>{contactName}</DetailRow>}
			{replyToEntries.length > 0 && (
				<DetailRow
					label={t("message.detailsReplyTo")}
					warning={isReplyToDifferent(message) ? t("message.detailsReplyToWarning") : null}
				>
					{formatRecipientAddressList(message.replyTo, "full")}
				</DetailRow>
			)}
			<DetailRow label={t("source.to")}>{formatRecipientAddressList(message.toAddr, "full") || "—"}</DetailRow>
			{splitEmailAddressList(message.ccAddr).length > 0 && (
				<DetailRow label={t("message.cc")}>{formatRecipientAddressList(message.ccAddr, "full")}</DetailRow>
			)}
			{splitEmailAddressList(message.bccAddr).length > 0 && (
				<DetailRow label={t("message.bcc")}>{formatRecipientAddressList(message.bccAddr, "full")}</DetailRow>
			)}
			<DetailRow label={t("message.date")}>
				{formatUserDate(message.createdAt, { weekday: "short", month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" })}
			</DetailRow>
			<DetailRow label={t("source.subject")}>{message.subject?.trim() || t("list.noSubject")}</DetailRow>
			{results?.mailedBy && <DetailRow label={t("message.detailsMailedBy")}>{results.mailedBy}</DetailRow>}
			{results?.signedBy && <DetailRow label={t("message.detailsSignedBy")}>{results.signedBy}</DetailRow>}
			{message.direction === "inbound" && (
				<DetailRow label={t("message.detailsSecurity")}>
					{authenticationFailed ? (
						t("message.detailsAuthenticationError")
					) : loading ? (
						t("message.detailsChecking")
					) : !results ? (
						t("message.detailsAuthenticationUnavailable")
					) : (
						<>
							{results.encryption && <p>{results.encryption}</p>}
							<p className="flex flex-wrap gap-x-3">
								{([["SPF", results.spf], ["DKIM", results.dkim], ["DMARC", results.dmarc]] as const).map(([method, result]) => (
									<span key={method} title={result?.detail ?? undefined}>
										{method}{" "}
										<span className={cn("font-medium", statusTone(result?.status))}>{result?.status ?? t("source.noResult")}</span>
									</span>
								))}
							</p>
							{hasDomainMismatchWarning(results) && (
								<p className="mt-1 flex items-start gap-1.5 text-amber-800">
									<ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
									<span>{t("message.detailsDomainMismatch")}</span>
								</p>
							)}
							{hasFailingAuthenticationCheck(results) && (
								<p className="mt-1 text-neutral-500">{t("message.detailsAuthenticationFailureNote")}</p>
							)}
						</>
					)}
				</DetailRow>
			)}
		</dl>
	);
}

/** Chevron beside the recipients that opens the message details in a popup. */
export function MessageDetailsPopover({ message, open, onOpenChange }: MessageDetailsPopoverProps) {
	const { t } = useLanguage();
	const [sourceOpen, setSourceOpen] = useState(false);

	return (
		// The popup is portaled, but React events still bubble to the card that toggles on click.
		<span className="inline-flex shrink-0" onClick={(event) => event.stopPropagation()} onKeyDown={(event) => event.stopPropagation()}>
			<DropdownMenu.Root open={open} onOpenChange={onOpenChange}>
				<DropdownMenu.Trigger
					aria-label={t("message.details")}
					title={t("message.details")}
					className="flex h-4 w-4 cursor-pointer items-center justify-center rounded text-neutral-500 hover:bg-neutral-200/70 hover:text-neutral-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40"
				>
					<ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />
				</DropdownMenu.Trigger>
				<DropdownMenu.Portal>
					<DropdownMenu.Content
						align="start"
						sideOffset={4}
						collisionPadding={8}
						className="z-[130] max-h-[var(--radix-dropdown-menu-content-available-height)] w-[min(30rem,calc(100vw-1rem))] cursor-auto overflow-y-auto rounded-lg border border-neutral-200 bg-white p-4 text-xs font-normal shadow-lg"
					>
						<MessageDetails message={message} />
						<DropdownMenu.Item
							onSelect={() => setSourceOpen(true)}
							className="mt-3 ml-[96px] inline-flex cursor-pointer items-center gap-1.5 rounded text-blue-600 outline-none data-[highlighted]:underline"
						>
							<ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
							{t("message.showOriginal")}
						</DropdownMenu.Item>
					</DropdownMenu.Content>
				</DropdownMenu.Portal>
			</DropdownMenu.Root>
			<MessageSourceDialog messageId={message.id} open={sourceOpen} onOpenChange={setSourceOpen} />
		</span>
	);
}

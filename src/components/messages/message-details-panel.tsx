"use client";

import { useId, useState, type ReactNode } from "react";
import { AlertTriangle, CheckCircle2, ExternalLink, LoaderCircle, ShieldAlert, ShieldCheck, X } from "@/components/icons";
import { useLanguage } from "@/components/language-provider";
import { Button } from "@/components/ui/button";
import { splitEmailAddressList } from "@/lib/email/address";
import { formatRecipientAddressList } from "@/lib/email/recipient-display";
import type { MessageAuthenticationMethod } from "@/lib/email/authentication-types";
import { formatUserDate } from "@/lib/time/utils";
import { cn } from "@/lib/utils";
import { MessageSourceDialog } from "./message-source-dialog";
import type { MessageDetailsPanelProps } from "./message-details-types";
import { useMessageAuthentication } from "./use-message-authentication";
import {
	getOriginalSender,
	getReplyToEntries,
	hasDomainMismatchWarning,
	hasFailingAuthenticationCheck,
	hasPassingAuthenticationCheck,
	hasSenderNameAddressMismatch,
	isReplyToDifferent,
} from "./message-details-utils";

function DetailRow({ label, children, warning }: { label: string; children: ReactNode; warning?: string | null }) {
	return (
		<div className="grid gap-0.5 sm:grid-cols-[92px_minmax(0,1fr)] sm:gap-3">
			<dt className="text-neutral-500">{label}</dt>
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

function statusTone(status: string | null): string {
	if (status === "PASS") return "text-green-700";
	if (status === "FAIL" || status === "SOFTFAIL" || status === "PERMERROR") return "text-red-700";
	if (status === "TEMPERROR" || status === "NEUTRAL" || status === "NONE") return "text-amber-700";
	return "text-neutral-800";
}

function AuthenticationRow({
	method,
	result,
	detail,
	noResult,
}: {
	method: string;
	result: MessageAuthenticationMethod | null;
	detail: string | null;
	noResult: string;
}) {
	const status = result?.status ?? null;
	const Icon = status === "PASS" ? CheckCircle2 : status === "FAIL" || status === "SOFTFAIL" || status === "PERMERROR" ? AlertTriangle : null;
	return (
		<li className="flex items-baseline gap-2">
			<span className="text-neutral-300" aria-hidden="true">•</span>
			<span className="w-10 shrink-0 font-medium text-neutral-700">{method}</span>
			<span className="min-w-0 flex-1 break-words">
				<span className={cn("inline-flex items-center gap-1 font-medium", statusTone(status))}>
					{Icon && <Icon className="h-3 w-3 shrink-0 self-center" aria-hidden="true" />}
					{status ?? noResult}
				</span>
				{result && detail && <span className="text-neutral-500"> · {detail}</span>}
			</span>
		</li>
	);
}

export function MessageDetailsPanel({ message, onClose, className }: MessageDetailsPanelProps) {
	const { t } = useLanguage();
	const messageSectionId = useId();
	const [sourceOpen, setSourceOpen] = useState(false);
	const { authentication, failed: authenticationFailed, loading } = useMessageAuthentication(message.id, message.direction);
	const original = getOriginalSender(message.fromAddr);
	const contactName = message.fromContactName?.trim();
	const showContactName = message.direction === "inbound" && !!contactName && contactName !== original.name;
	const replyToEntries = getReplyToEntries(message.replyTo);
	const replyToWarning = isReplyToDifferent(message);
	const senderNameWarning = hasSenderNameAddressMismatch(message);
	const hasPassingCheck = hasPassingAuthenticationCheck(authentication);
	const hasFailingCheck = hasFailingAuthenticationCheck(authentication);

	const spfDetail = authentication?.available
		? authentication.mailedBy
			? `mailed by ${authentication.mailedBy}${authentication.spf?.detail ? ` · ${authentication.spf.detail}` : ""}`
			: authentication.spf?.detail ?? null
		: null;

	return (
		<section
			aria-label={t("message.detailsTitle")}
			className={cn("overflow-hidden rounded-xl border border-neutral-200 bg-white text-xs", className)}
		>
			<header className="flex items-center justify-between gap-2 border-b border-neutral-100 bg-neutral-50/80 px-3 py-2">
				<h2 className="text-[11px] font-semibold uppercase tracking-[0.08em] text-neutral-500">
					{t("message.detailsTitle")}
				</h2>
				{onClose && (
					<button
						type="button"
						onClick={onClose}
						aria-label={t("navigation.close")}
						className="rounded p-0.5 text-neutral-400 transition-colors hover:bg-neutral-200/60 hover:text-neutral-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40"
					>
						<X className="h-3.5 w-3.5" aria-hidden="true" />
					</button>
				)}
			</header>

			<div
				className={cn(
					"grid gap-4 px-3 py-3",
					message.direction === "inbound" && "sm:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)] sm:gap-6",
				)}
			>
				<section aria-labelledby={messageSectionId}>
					<h3 id={messageSectionId} className="text-[10px] font-semibold uppercase tracking-[0.08em] text-neutral-400">
						{t("message.detailsMessageSection")}
					</h3>
					<dl className="mt-2 space-y-2">
						<DetailRow
							label={t("message.detailsFrom")}
							warning={senderNameWarning ? t("message.detailsSenderWarning") : null}
						>
							{original.name ? (
								<>
									<span className="font-medium">{original.name}</span>{" "}
									<span className="text-neutral-500">&lt;{original.address}&gt;</span>
								</>
							) : original.address}
						</DetailRow>
						{showContactName && <DetailRow label={t("message.detailsContact")}>{contactName}</DetailRow>}
						{replyToEntries.length > 0 && (
							<DetailRow
								label={t("message.detailsReplyTo")}
								warning={replyToWarning ? t("message.detailsReplyToWarning") : null}
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
					</dl>
				</section>

				{message.direction === "inbound" && (
					<section>
						<h3 className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-neutral-400">
							<ShieldCheck className="h-3.5 w-3.5" aria-hidden="true" />
							{t("message.detailsAuthentication")}
						</h3>
						{authenticationFailed ? (
							<p className="mt-2 text-neutral-500">{t("message.detailsAuthenticationError")}</p>
						) : loading ? (
							<p className="mt-2 flex items-center gap-1.5 text-neutral-500">
								<LoaderCircle className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
								{t("message.detailsChecking")}
							</p>
						) : !authentication || !authentication.available ? (
							<p className="mt-2 text-neutral-500">{t("message.detailsAuthenticationUnavailable")}</p>
						) : (
							<>
								<ul className="mt-2 space-y-1">
									<AuthenticationRow method="SPF" result={authentication.spf} detail={spfDetail} noResult={t("source.noResult")} />
									<AuthenticationRow method="DKIM" result={authentication.dkim} detail={authentication.dkim?.detail ?? null} noResult={t("source.noResult")} />
									<AuthenticationRow method="DMARC" result={authentication.dmarc} detail={authentication.dmarc?.detail ?? null} noResult={t("source.noResult")} />
								</ul>
								{authentication.encryption && (
									<p className="mt-2 text-neutral-500">
										{t("message.detailsEncryption")} <span className="text-neutral-900">{authentication.encryption}</span>
									</p>
								)}
								{hasDomainMismatchWarning(authentication) && (
									<p className="mt-2 flex items-start gap-1.5 text-amber-800">
										<ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
										<span>{t("message.detailsDomainMismatch")}</span>
									</p>
								)}
								{(hasPassingCheck || hasFailingCheck) && (
									<div className="mt-3 rounded-lg bg-neutral-100/70 px-2.5 py-2">
										<h4 className="text-[10px] font-semibold uppercase tracking-[0.08em] text-neutral-500">
											{t("message.detailsExplanationTitle")}
										</h4>
										<div className="mt-1 space-y-1 text-[11px] leading-snug text-neutral-600">
											{hasPassingCheck && <p>{t("message.detailsAuthenticationNote")}</p>}
											{hasFailingCheck && <p>{t("message.detailsAuthenticationFailureNote")}</p>}
										</div>
									</div>
								)}
							</>
						)}
					</section>
				)}
			</div>

			<footer className="flex justify-end border-t border-neutral-100 px-3 py-2">
				<Button type="button" variant="ghost" size="sm" className="h-7 px-2 text-blue-600 hover:text-blue-700" onClick={() => setSourceOpen(true)}>
					<ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
					{t("message.showOriginal")}
				</Button>
			</footer>
			<MessageSourceDialog messageId={message.id} open={sourceOpen} onOpenChange={setSourceOpen} />
		</section>
	);
}

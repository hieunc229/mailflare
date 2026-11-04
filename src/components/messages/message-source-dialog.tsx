"use client";

import { useEffect, useMemo, useState } from "react";
import { CheckCircle2, Copy, Download, LoaderCircle } from "@/components/icons";
import { useLanguage } from "@/components/language-provider";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import type { MessageSourceDialogProps } from "./message-source-dialog-types";
import { copyMessageSource, downloadMessageSource, fetchMessageSource, summarizeMessageSource } from "./message-source-utils";

export function MessageSourceDialog({ messageId, open, onOpenChange }: MessageSourceDialogProps) {
	const { t } = useLanguage();
	const [source, setSource] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [loading, setLoading] = useState(false);
	const [copied, setCopied] = useState(false);
	const [copyError, setCopyError] = useState(false);
	const summary = useMemo(() => source === null ? null : summarizeMessageSource(source), [source]);

	useEffect(() => {
		if (!open) return;
		const controller = new AbortController();
		setSource(null);
		setError(null);
		setCopied(false);
		setCopyError(false);
		setLoading(true);
		fetchMessageSource(messageId, controller.signal)
			.then((value) => {
				if (!controller.signal.aborted) setSource(value);
			})
			.catch((reason) => {
				if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : t("source.loadFailed"));
			})
			.finally(() => {
				if (!controller.signal.aborted) setLoading(false);
			});
		return () => controller.abort();
	}, [messageId, open]);

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="max-h-[90vh] w-[min(960px,calc(100vw-32px))] overflow-y-auto">
				<DialogHeader>
					<DialogTitle>{t("source.title")}</DialogTitle>
					<DialogDescription>{t("source.description")}</DialogDescription>
				</DialogHeader>
				{loading && <div className="flex items-center gap-2 text-sm text-neutral-500"><LoaderCircle className="h-4 w-4 animate-spin" />{t("source.loading")}</div>}
				{error && <p className="text-sm text-neutral-600">{error}</p>}
				{source !== null && summary && (
					<div className="space-y-5">
						<div className="overflow-hidden rounded-lg border border-neutral-200 text-sm">
							{([
								["messageId", summary.messageId],
								["createdAt", summary.createdAt],
								["from", summary.from],
								["to", summary.to],
								["subject", summary.subject],
							] as const).map(([label, value]) => (
								<div key={label} className="grid gap-1 border-b border-neutral-200 px-4 py-3 last:border-b-0 sm:grid-cols-[140px_minmax(0,1fr)] sm:gap-4">
									<span className="font-medium text-neutral-700">{t(`source.${label}`)}</span>
									<span className={label === "messageId" && value ? "break-all text-green-700" : "break-words text-neutral-900"}>{value || t("source.unavailable")}</span>
								</div>
							))}
							{(["spf", "dkim", "dmarc"] as const).map((method) => {
								const result = summary[method];
								return (
									<div key={method} className="grid gap-1 border-b border-neutral-200 px-4 py-3 last:border-b-0 sm:grid-cols-[140px_minmax(0,1fr)] sm:gap-4">
										<span className="font-medium uppercase text-neutral-700">{method}</span>
										<span className="flex min-w-0 items-center gap-1.5 break-all text-neutral-900">
											{result?.status === "PASS" && <CheckCircle2 className="h-4 w-4 shrink-0 text-green-600" aria-label={t("source.passed", { method: method.toUpperCase() })} />}
											{result ? `${result.status}${result.detail ? ` ${result.detail}` : ""}` : t("source.noResult")}
										</span>
									</div>
								);
							})}
						</div>
						<div className="flex flex-wrap items-center justify-between gap-3">
							<Button type="button" variant="ghost" size="sm" className="text-blue-600 hover:text-blue-700" onClick={() => downloadMessageSource(source, messageId)}><Download className="h-4 w-4" />{t("source.download")}</Button>
							<div className="flex items-center gap-2">
								{copyError && <span role="alert" className="text-xs text-red-600">{t("source.couldNotCopy")}</span>}
								<Button type="button" size="sm" onClick={() => { void copyMessageSource(source).then(() => { setCopied(true); setCopyError(false); }).catch(() => { setCopied(false); setCopyError(true); }); }}><Copy className="h-4 w-4" />{copied ? t("source.copied") : t("source.copy")}</Button>
							</div>
						</div>
						<pre className="max-h-[40vh] overflow-auto rounded-lg border border-neutral-200 bg-neutral-50 p-4 font-mono text-xs leading-relaxed text-neutral-700 whitespace-pre">{source}</pre>
					</div>
				)}
			</DialogContent>
		</Dialog>
	);
}

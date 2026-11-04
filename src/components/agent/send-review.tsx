"use client";

import { useEffect, useState } from "react";
import { useLanguage } from "@/components/language-provider";
import { authFetch } from "@/lib/auth/client";
import { formatUserDate } from "@/lib/time/utils";
import { htmlToPlainText } from "@/components/compose/rich-text-utils";
import type { SendReviewProps } from "./send-review-types";

export function SendReview({ approvalId, snapshot, unfamiliarRecipients: provided, onClose, onSent }: SendReviewProps) {
	const { t } = useLanguage();
	const [fetched, setFetched] = useState<string[]>([]);
	const unfamiliarRecipients = provided ?? fetched;
	useEffect(() => {
		if (provided) return;
		// Callers that only hold the snapshot still get the "never written to" warning.
		void authFetch(`/api/agent/approvals/${approvalId}`).then(async (response) => {
			const data = await response.json() as { unfamiliarRecipients?: string[] };
			if (response.ok) setFetched(data.unfamiliarRecipients ?? []);
		}).catch(() => undefined);
	}, [approvalId, provided]);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	async function confirm() {
		setBusy(true);
		setError(null);
		try {
			const response = await authFetch(`/api/agent/approvals/${approvalId}/confirm`, { method: "POST" });
			const result = await response.json() as { status?: string; messageId?: string; error?: string };
			if (!response.ok || result.status !== "sent" || !result.messageId) throw new Error(result.error || t("agent.review.deliveryNeedsReview"));
			window.dispatchEvent(new Event("mailflare:messages-changed"));
			onSent?.(result.messageId);
		} catch (cause) { setError(cause instanceof Error ? cause.message : t("agent.review.couldNotSend")); }
		finally { setBusy(false); }
	}
	return <div className="fixed inset-0 z-[70] flex items-center justify-center bg-neutral-950/60 p-4" role="dialog" aria-modal="true" aria-label={t("agent.review.dialog")}>
		<div className="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-xl bg-white p-5 shadow-2xl">
			<h2 className="text-lg font-semibold">{snapshot.scheduledAt ? t("agent.review.reviewSchedule") : t("agent.review.reviewSend")}</h2>
			<p className="mt-1 text-sm text-neutral-500">{snapshot.scheduledAt ? t("agent.review.confirmScheduled") : t("agent.review.confirmDelivered")}</p>
			<p className="mt-3 rounded-lg bg-amber-50 p-2 text-sm text-amber-900">{t("agent.review.aiWritten")}</p>
			{unfamiliarRecipients.length > 0 && <p role="alert" className="mt-2 rounded-lg bg-red-50 p-2 text-sm text-red-800">{t("agent.review.unfamiliarRecipients", { list: unfamiliarRecipients.join(", ") })}</p>}
			<dl className="mt-4 grid grid-cols-[5rem_1fr] gap-2 text-sm break-words">
				<dt className="text-neutral-500">{t("agent.review.from")}</dt><dd>{snapshot.from}</dd>
				<dt className="text-neutral-500">{t("agent.review.to")}</dt><dd>{snapshot.to}</dd>
				{snapshot.cc && <><dt className="text-neutral-500">{t("agent.review.cc")}</dt><dd>{snapshot.cc}</dd></>}
				{snapshot.bcc && <><dt className="text-neutral-500">{t("agent.review.bcc")}</dt><dd>{snapshot.bcc}</dd></>}
				<dt className="text-neutral-500">{t("agent.review.subject")}</dt><dd>{snapshot.subject}</dd>
				{snapshot.scheduledAt && <><dt className="text-neutral-500">{t("agent.review.sendAt")}</dt><dd>{formatUserDate(snapshot.scheduledAt, { dateStyle: "medium", timeStyle: "short" })}</dd></>}
			</dl>
			<pre className="mt-4 max-h-72 overflow-auto whitespace-pre-wrap rounded-lg border border-neutral-200 p-3 text-sm">{snapshot.text || htmlToPlainText(snapshot.html || "")}</pre>
			{snapshot.attachments.length > 0 && <p className="mt-3 text-sm">{t("agent.review.attachments", { list: snapshot.attachments.map((item) => `${item.filename} (${Math.max(1, Math.round(item.size / 1024))} KB)`).join(", ") })}</p>}
			{error && <p role="alert" className="mt-3 text-sm text-red-600">{error}</p>}
			<div className="mt-5 flex justify-end gap-3">
				{onClose && <button type="button" className="rounded-lg border px-4 py-2" onClick={onClose} disabled={busy}>{t("common.cancel")}</button>}
				<button type="button" className="rounded-lg bg-blue-600 px-4 py-2 font-medium text-white disabled:opacity-50" onClick={() => void confirm()} disabled={busy}>{busy ? snapshot.scheduledAt ? t("agent.review.scheduling") : t("agent.review.sending") : snapshot.scheduledAt ? t("agent.review.confirmSchedule") : t("agent.review.confirmSend")}</button>
			</div>
		</div>
	</div>;
}

"use client";

import { useEffect, useState } from "react";
import { useLanguage } from "@/components/language-provider";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { DmarcPlan } from "./types";
import { errorKey } from "./dmarc-utils";
import { putReports } from "./utils";

type Props = { domainId: string; enable: boolean; onClose: () => void; onDone: () => void };

/** Shows the `_dmarc` change before it is made: the server answers a preview until the admin confirms. */
export function DmarcRecordPreviewDialog({ domainId, enable, onClose, onDone }: Props) {
	const { t } = useLanguage();
	const [plan, setPlan] = useState<DmarcPlan | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);

	const describe = (cause: unknown) => {
		const key = errorKey((cause as { code?: string }).code);
		return key ? t(key) : t("dmarc.error.generic");
	};

	useEffect(() => {
		let active = true;
		void putReports(domainId, { enabled: enable }).then((result) => { if (active && result.kind === "preview") setPlan(result.plan); }).catch((cause) => { if (active) setError(describe(cause)); });
		return () => { active = false; };
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [domainId, enable]);

	async function confirm() {
		if (!plan) return;
		setBusy(true);
		setError(null);
		try {
			// Confirm applies exactly what was shown; the server refuses if `_dmarc` changed in the meantime.
			await putReports(domainId, { enabled: enable, confirm: true, previewed: { before: plan.before, after: plan.after } });
			onDone();
		} catch (cause) {
			setError(describe(cause));
			setBusy(false);
		}
	}

	return <Dialog open onOpenChange={(open) => { if (!open && !busy) onClose(); }}>
		<DialogContent className="max-h-[calc(100vh-4rem)] overflow-y-auto">
			<DialogHeader>
				<DialogTitle>{t(enable ? "dmarc.turnOn" : "dmarc.turnOff")}</DialogTitle>
				<DialogDescription>{t(enable ? "dmarc.preview.on.intro" : "dmarc.preview.off.intro", { address: plan?.address ?? "mailflare-reports" })}</DialogDescription>
			</DialogHeader>
			{plan && <div className="space-y-4 text-sm">
				<div><p className="font-semibold text-neutral-900">{t("dmarc.preview.before")}</p><pre className="mt-1 whitespace-pre-wrap break-all rounded-lg bg-neutral-100 p-3 text-xs">{plan.before ?? t("dmarc.preview.none")}</pre></div>
				<div><p className="font-semibold text-neutral-900">{t("dmarc.preview.after")}</p><pre className="mt-1 whitespace-pre-wrap break-all rounded-lg bg-neutral-100 p-3 text-xs">{plan.after ?? t("dmarc.preview.none")}</pre></div>
				{!plan.changed && <p className="text-neutral-600">{t("dmarc.preview.unchanged")}</p>}
				{plan.changed && plan.manual && <p className="text-neutral-600">{t("dmarc.preview.manual")}</p>}
			</div>}
			{!plan && !error && <p className="text-sm text-neutral-500" role="status">{t("deliverability.loading")}</p>}
			{error && <p role="alert" className="mt-3 text-sm text-red-700">{error}</p>}
			<div className="mt-6 flex justify-end gap-3">
				<Button type="button" variant="outline" disabled={busy} onClick={onClose}>{t("dmarc.preview.cancel")}</Button>
				<Button type="button" disabled={!plan || busy} onClick={() => void confirm()}>{busy ? t("dmarc.preview.working") : t(enable ? "dmarc.preview.confirmOn" : "dmarc.preview.confirmOff")}</Button>
			</div>
		</DialogContent>
	</Dialog>;
}

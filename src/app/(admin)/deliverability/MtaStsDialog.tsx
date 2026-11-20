"use client";

import { useState } from "react";
import { useLanguage } from "@/components/language-provider";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";

type Props = { kind: "enforce" | "off"; days: number; busy: boolean; error: string | null; onConfirm: (acknowledged: boolean) => void; onClose: () => void };

/** Enforce can make other servers refuse to deliver, so it needs an explicit acknowledgement; turning off explains the removal period. */
export function MtaStsDialog({ kind, days, busy, error, onConfirm, onClose }: Props) {
	const { t } = useLanguage();
	const [acknowledged, setAcknowledged] = useState(false);
	return <Dialog open onOpenChange={(open) => { if (!open && !busy) onClose(); }}>
		<DialogContent className="max-h-[calc(100vh-4rem)] overflow-y-auto">
			<DialogHeader>
				<DialogTitle>{t(kind === "enforce" ? "mtasts.dialog.enforce.title" : "mtasts.dialog.off.title")}</DialogTitle>
				<DialogDescription>{kind === "enforce" ? t("mtasts.dialog.enforce.body") : t("mtasts.dialog.off.body", { days })}</DialogDescription>
			</DialogHeader>
			{kind === "enforce" && <label className="flex items-start gap-2 text-sm text-neutral-800"><Checkbox className="mt-0.5" checked={acknowledged} onChange={(event) => setAcknowledged(event.target.checked)} />{t("mtasts.dialog.enforce.ack")}</label>}
			{error && <p role="alert" className="mt-3 text-sm text-red-700">{error}</p>}
			<div className="mt-6 flex justify-end gap-3">
				<Button type="button" variant="outline" disabled={busy} onClick={onClose}>{t("dmarc.preview.cancel")}</Button>
				<Button type="button" disabled={busy || (kind === "enforce" && !acknowledged)} onClick={() => onConfirm(acknowledged)}>{busy ? t("dmarc.preview.working") : t("mtasts.dialog.confirm")}</Button>
			</div>
		</DialogContent>
	</Dialog>;
}

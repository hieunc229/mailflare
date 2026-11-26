"use client";

import { AlertCircle, Loader2 } from "@/components/icons";
import { useLanguage } from "@/components/language-provider";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";

export type OrgFreeBusyViewProps = {
	/** `unavailable`: no Team licence, so the switch is not offered at all. */
	state: "loading" | "error" | "ready" | "unavailable";
	enabled: boolean;
	saving: boolean;
	/** Translated outcome of the last save, or "". */
	status: string;
	onChange: (enabled: boolean) => void;
	onRetry: () => void;
};

/** Presentation only: the container owns the requests, so every state can be rendered on its own. */
export function OrgFreeBusyView({ state, enabled, saving, status, onChange, onRetry }: OrgFreeBusyViewProps) {
	const { t } = useLanguage();
	if (state === "unavailable") return null;
	return (
		<Card className="rounded-3xl border-0 bg-white p-6">
			<CardHeader className="py-0"><CardTitle>{t("general.orgFreeBusy")}</CardTitle></CardHeader>
			<CardContent className="space-y-3 pt-6">
				{state === "loading" && <p role="status" className="flex items-center gap-2 text-sm text-neutral-600"><Loader2 aria-hidden="true" className="h-4 w-4 animate-spin motion-reduce:animate-none" />{t("general.orgFreeBusyLoading")}</p>}
				{state === "error" && (
					<div role="alert" className="flex flex-wrap items-center gap-2 text-sm text-red-700">
						<AlertCircle aria-hidden="true" className="h-4 w-4 shrink-0" />
						<span className="min-w-0 flex-1">{t("general.orgFreeBusyLoadFailed")}</span>
						<button type="button" onClick={onRetry} className="min-h-11 rounded-md px-3 font-medium text-blue-700 underline hover:bg-blue-50 focus-visible:outline-2 focus-visible:outline-blue-600">{t("general.orgFreeBusyRetry")}</button>
					</div>
				)}
				{state === "ready" && <>
					<div className="flex items-center gap-3"><Switch id="org-free-busy" checked={enabled} onCheckedChange={onChange} disabled={saving} aria-describedby="org-free-busy-hint" /><Label htmlFor="org-free-busy">{t("general.orgFreeBusyEnabled")}</Label></div>
					<p id="org-free-busy-hint" className="text-sm text-neutral-600">{t("general.orgFreeBusyHint")}</p>
					{status && <p role="status" className="text-sm text-neutral-700">{status}</p>}
				</>}
			</CardContent>
		</Card>
	);
}

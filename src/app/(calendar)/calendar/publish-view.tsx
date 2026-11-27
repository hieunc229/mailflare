"use client";

import { useId } from "react";
import { AlertCircle, Copy, Loader2 } from "@/components/icons";
import { useLanguage } from "@/components/language-provider";
import { Button } from "@/components/ui/button";

const touch = "[@media(pointer:coarse)]:min-h-11 [@media(pointer:coarse)]:min-w-11";

export type PublishViewProps = {
	state: "loading" | "error" | "off" | "on";
	/** The two addresses, only in the moment the link was made: the key is stored hashed. */
	urls: { ifb: string; ics: string } | null;
	/** A formatted date for a link made earlier. */
	since: string;
	/** A turn on or off is running. */
	pending: boolean;
	/** Translated text of the last failed change, or "". */
	error: string;
	onTurnOn: () => void;
	onTurnOff: () => void;
	onCopy: (url: string) => void;
	onRetry: () => void;
};

function UrlRow({ label, hint, value, copyLabel, onCopy }: { label: string; hint: string; value: string; copyLabel: string; onCopy: () => void }) {
	const { t } = useLanguage();
	const id = useId();
	const hintId = useId();
	return (
		<div>
			<label htmlFor={id} className="mb-1 block text-xs font-medium text-neutral-800">{label}</label>
			<div className="flex items-center gap-2">
				<input id={id} readOnly value={value} aria-describedby={hintId} onFocus={(event) => event.currentTarget.select()} className="h-10 min-w-0 flex-1 rounded-lg border border-neutral-200 bg-neutral-50 px-3 text-xs text-neutral-800 focus-visible:outline-2 focus-visible:outline-blue-600" />
				<Button type="button" variant="outline" onClick={onCopy} aria-label={copyLabel} className={`shrink-0 px-3 ${touch}`}><Copy aria-hidden="true" className="h-4 w-4" />{t("calendar.publish.copy")}</Button>
			</div>
			<p id={hintId} className="mt-1 text-xs text-neutral-600">{hint}</p>
		</div>
	);
}

/** Presentation only: the container owns the requests, so every state can be rendered and tested on its own. */
export function PublishView(props: PublishViewProps) {
	const { t } = useLanguage();
	const titleId = useId();
	const on = props.state === "on";
	return (
		<section aria-labelledby={titleId} className="space-y-3 text-sm text-neutral-700">
			<div className="flex items-center justify-between gap-3">
				<h3 id={titleId} className="font-semibold text-neutral-900">{t("calendar.publish.title")}</h3>
				{(props.state === "on" || props.state === "off") && (
					<span className={`rounded-full px-2 py-0.5 text-xs font-medium ${on ? "bg-green-100 text-green-800" : "bg-neutral-100 text-neutral-700"}`}>{t(on ? "calendar.publish.status.on" : "calendar.publish.status.off")}</span>
				)}
			</div>
			{props.state === "loading" && (
				<p role="status" className="flex items-center gap-2 text-neutral-500"><Loader2 aria-hidden="true" className="h-4 w-4 animate-spin motion-reduce:animate-none" />{t("calendar.publish.loading")}</p>
			)}
			{props.state === "error" && (
				<div role="alert" className="flex items-start gap-2 text-red-700">
					<AlertCircle aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
					<span className="min-w-0 flex-1">{t("calendar.publish.loadFailed")}</span>
					<button type="button" onClick={props.onRetry} className={`rounded-md px-2 font-medium text-blue-700 underline hover:bg-blue-50 ${touch}`}>{t("calendar.publish.retry")}</button>
				</div>
			)}
			{props.state === "off" && (
				<>
					<p>{t("calendar.publish.explain")}</p>
					<Button type="button" disabled={props.pending} aria-busy={props.pending} onClick={props.onTurnOn} className="[@media(pointer:coarse)]:min-h-11">{props.pending ? t("calendar.publish.turningOn") : t("calendar.publish.turnOn")}</Button>
				</>
			)}
			{on && (
				<>
					{props.urls ? (
						<div className="space-y-3">
							<p className="font-medium text-amber-900">{t("calendar.publish.once")}</p>
							<UrlRow label={t("calendar.publish.ifb")} hint={t("calendar.publish.ifbHint")} value={props.urls.ifb} copyLabel={t("calendar.publish.copyNamed", { name: t("calendar.publish.ifb") })} onCopy={() => props.onCopy(props.urls!.ifb)} />
							<UrlRow label={t("calendar.publish.ics")} hint={t("calendar.publish.icsHint")} value={props.urls.ics} copyLabel={t("calendar.publish.copyNamed", { name: t("calendar.publish.ics") })} onCopy={() => props.onCopy(props.urls!.ics)} />
						</div>
					) : (
						<p>{t("calendar.publish.alreadyOn", { date: props.since })}</p>
					)}
					<Button type="button" variant="outline" disabled={props.pending} aria-busy={props.pending} onClick={props.onTurnOff} className="[@media(pointer:coarse)]:min-h-11">{props.pending ? t("calendar.publish.turningOff") : t("calendar.publish.turnOff")}</Button>
				</>
			)}
			{props.error && <p role="alert" className="text-red-700">{props.error}</p>}
		</section>
	);
}

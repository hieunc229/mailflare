"use client";

import { useState } from "react";
import { useLanguage } from "@/components/language-provider";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import type { DeliverabilitySettings, SuppressionMode } from "./types";
import { fetchSettings, saveMode, setFeed } from "./utils";

type Props = { settings: DeliverabilitySettings; onChange: (settings: DeliverabilitySettings) => void };

export function SettingsPanel({ settings, onChange }: Props) {
	const { t } = useLanguage();
	const [busy, setBusy] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);

	async function run(name: string, action: () => Promise<DeliverabilitySettings | void>, failure: string) {
		setBusy(name);
		setError(null);
		try {
			const next = await action();
			onChange(next ?? await fetchSettings());
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : failure);
		} finally {
			setBusy(null);
		}
	}

	const feeds = [
		{ id: "resend" as const, label: "Resend", connected: settings.feeds.resend },
		{ id: "ses" as const, label: "Amazon SES", connected: !!settings.feeds.ses },
	];
	return <section className="space-y-5 rounded-2xl bg-white p-5">
		<div className="space-y-2">
			<label htmlFor="suppression-mode" className="block text-sm font-semibold text-neutral-900">{t("deliverability.mode.label")}</label>
			<Select
				id="suppression-mode"
				value={settings.suppressionMode}
				disabled={!settings.canEdit || busy !== null}
				containerClassName="w-full sm:w-96"
				className="h-10 text-sm"
				onChange={(event) => void run("mode", () => saveMode(event.target.value as SuppressionMode), t("deliverability.mode.saveFailed"))}
			>
				<option value="off">{t("deliverability.mode.off")}</option>
				<option value="record">{t("deliverability.mode.record")}</option>
				<option value="enforce">{t("deliverability.mode.enforce")}</option>
			</Select>
			{!settings.canEdit && <p className="text-xs text-neutral-500">{t("deliverability.mode.readOnly")}</p>}
		</div>
		<div className="space-y-3">
			<h2 className="text-sm font-semibold text-neutral-900">{t("deliverability.feeds.title")}</h2>
			<ul className="space-y-2">
				{feeds.map((feed) => <li key={feed.id} className="flex flex-wrap items-center justify-between gap-3 text-sm">
					<span><span className="font-medium text-neutral-900">{feed.label}</span> <span className="text-neutral-500">{feed.connected ? t("deliverability.feeds.connected") : t("deliverability.feeds.notConnected")}</span></span>
					{settings.canEdit && <Button type="button" variant="outline" size="sm" disabled={busy !== null} onClick={() => void run(feed.id, () => setFeed(feed.id, !feed.connected), t("deliverability.feeds.failed"))}>{feed.connected ? t("deliverability.feeds.disconnect") : t("deliverability.feeds.connect")}</Button>}
				</li>)}
			</ul>
			<p className="text-xs text-neutral-500">{t("deliverability.feeds.dsn")}</p>
		</div>
		{error && <p role="alert" className="text-sm text-red-700">{error}</p>}
	</section>;
}

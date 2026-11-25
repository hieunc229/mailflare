"use client";

import { useEffect, useState } from "react";
import { authFetch } from "@/lib/auth/client";
import { useLanguage } from "@/components/language-provider";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";

type Strictness = "relaxed" | "normal" | "strict";
type SpamSettings = { enabled?: boolean; strictness?: Strictness; error?: string };

const STRICTNESS_OPTIONS = [
	{ value: "relaxed", title: "settings.spam.strictness.relaxed" },
	{ value: "normal", title: "settings.spam.strictness.normal" },
	{ value: "strict", title: "settings.spam.strictness.strict" },
] as const;

export function SpamFilterSettings() {
	const { t } = useLanguage();
	const [enabled, setEnabled] = useState(true);
	const [strictness, setStrictness] = useState<Strictness>("strict");
	const [status, setStatus] = useState<"loading" | "ready" | "failed">("loading");
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [attempt, setAttempt] = useState(0);

	// The defaults above are placeholders: nothing is editable until the real values arrive.
	useEffect(() => {
		let active = true;
		void authFetch("/api/settings/spam")
			.then(async (response) => {
				const data = await response.json() as SpamSettings;
				if (!response.ok) throw new Error();
				if (!active) return;
				setEnabled(data.enabled !== false);
				setStrictness(data.strictness ?? "strict");
				setStatus("ready");
			})
			.catch(() => { if (active) setStatus("failed"); });
		return () => { active = false; };
	}, [attempt]);

	function retry() {
		setStatus("loading");
		setAttempt((value) => value + 1);
	}

	async function updateEnabled(nextEnabled: boolean) {
		const previous = enabled;
		setEnabled(nextEnabled);
		setSaving(true);
		setError(null);
		try {
			const response = await authFetch("/api/settings/spam", {
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ enabled: nextEnabled }),
			});
			const data = await response.json() as { enabled?: boolean; error?: string };
			if (!response.ok) throw new Error(data.error ?? t("settings.spam.updateFailed"));
			setEnabled(data.enabled !== false);
		} catch (nextError) {
			setEnabled(previous);
			setError(nextError instanceof Error ? nextError.message : t("settings.spam.updateFailed"));
		} finally {
			setSaving(false);
		}
	}

	async function updateStrictness(next: Strictness) {
		const previous = strictness;
		setStrictness(next);
		setSaving(true);
		setError(null);
		try {
			const response = await authFetch("/api/settings/spam", {
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ strictness: next }),
			});
			const data = await response.json() as SpamSettings;
			if (!response.ok) throw new Error(data.error ?? t("settings.spam.updateFailed"));
			setStrictness(data.strictness ?? next);
		} catch (nextError) {
			setStrictness(previous);
			setError(nextError instanceof Error ? nextError.message : t("settings.spam.updateFailed"));
		} finally {
			setSaving(false);
		}
	}

	const ready = status === "ready";
	return (
		<div aria-busy={status === "loading"}>
			<label className="flex items-start gap-3 rounded-xl bg-neutral-50 p-4">
				<span className="flex-1">
					<span className="block text-sm font-medium text-neutral-900">{t("settings.spam.title")}</span>
					<span className="mt-1 block text-sm text-neutral-500">{t("settings.spam.description")}</span>
				</span>
				{ready
					? <Switch checked={enabled} disabled={saving} onCheckedChange={(value) => void updateEnabled(value)} aria-label={t("settings.spam.enable")} />
					: <Skeleton className="h-6 w-11 rounded-full" />}
			</label>
			<div role="radiogroup" aria-label={t("settings.spam.strictness")} className="mt-3 rounded-xl bg-neutral-50 p-4">
				<p className="text-sm font-medium text-neutral-900">{t("settings.spam.strictness")}</p>
				<p className="mt-1 text-sm text-neutral-500">{t("settings.spam.strictnessDescription")}</p>
				<div className="mt-3 space-y-2">
					{!ready && STRICTNESS_OPTIONS.map((option) => <Skeleton key={option.value} className="h-5 w-40" />)}
					{ready && STRICTNESS_OPTIONS.map((option) => (
						<label key={option.value} className="flex cursor-pointer items-center gap-3">
							<input
								type="radio"
								name="spam-strictness"
								checked={strictness === option.value}
								disabled={saving || !enabled}
								onChange={() => void updateStrictness(option.value)}
							/>
							<span className="text-sm text-neutral-900">{t(option.title)}</span>
						</label>
					))}
				</div>
			</div>
			{status === "failed" && (
				<div role="alert" className="mt-2 flex flex-wrap items-center gap-3 px-4 text-sm text-red-600">
					<p>{t("settings.spam.loadFailed")}</p>
					<Button type="button" variant="outline" size="sm" onClick={retry}>{t("webhooks.retry")}</Button>
				</div>
			)}
			{error && <p role="alert" className="mt-2 px-4 text-sm text-red-600">{error}</p>}
		</div>
	);
}

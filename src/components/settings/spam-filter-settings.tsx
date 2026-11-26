"use client";

import { useEffect, useState } from "react";
import { authFetch } from "@/lib/auth/client";
import { useLanguage } from "@/components/language-provider";
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
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		void authFetch("/api/settings/spam")
			.then(async (response) => {
				const data = await response.json() as SpamSettings;
				if (!response.ok) throw new Error(data.error ?? t("settings.spam.loadFailed"));
				setEnabled(data.enabled !== false);
				setStrictness(data.strictness ?? "strict");
			})
			.catch((nextError) => setError(nextError instanceof Error ? nextError.message : t("settings.spam.loadFailed")))
			.finally(() => setLoading(false));
	}, []);

	async function updateEnabled(nextEnabled: boolean) {
		const previous = enabled;
		setEnabled(nextEnabled);
		setLoading(true);
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
			setLoading(false);
		}
	}

	async function updateStrictness(next: Strictness) {
		const previous = strictness;
		setStrictness(next);
		setLoading(true);
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
			setLoading(false);
		}
	}

	return (
		<div>
			<label className="flex items-start gap-3 rounded-xl bg-neutral-50 p-4">
				<span className="flex-1">
					<span className="block text-sm font-medium text-neutral-900">{t("settings.spam.title")}</span>
					<span className="mt-1 block text-sm text-neutral-500">{t("settings.spam.description")}</span>
				</span>
				<Switch checked={enabled} disabled={loading} onCheckedChange={(value) => void updateEnabled(value)} aria-label={t("settings.spam.enable")} />
			</label>
			<div role="radiogroup" aria-label={t("settings.spam.strictness")} className="mt-3 rounded-xl bg-neutral-50 p-4">
				<p className="text-sm font-medium text-neutral-900">{t("settings.spam.strictness")}</p>
				<p className="mt-1 text-sm text-neutral-500">{t("settings.spam.strictnessDescription")}</p>
				<div className="mt-3 space-y-2">
					{STRICTNESS_OPTIONS.map((option) => (
						<label key={option.value} className="flex cursor-pointer items-center gap-3">
							<input
								type="radio"
								name="spam-strictness"
								checked={strictness === option.value}
								disabled={loading || !enabled}
								onChange={() => void updateStrictness(option.value)}
							/>
							<span className="text-sm text-neutral-900">{t(option.title)}</span>
						</label>
					))}
				</div>
			</div>
			{error && <p role="alert" className="mt-2 px-4 text-sm text-red-600">{error}</p>}
		</div>
	);
}

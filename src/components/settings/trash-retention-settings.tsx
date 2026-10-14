"use client";

import { CustomSelect } from "@/components/ui/custom-select";

import { useEffect, useState } from "react";
import { useLanguage } from "@/components/language-provider";
import { authFetch } from "@/lib/auth/client";
import { TRASH_RETENTION_OPTIONS, describeTrashRetention } from "@/lib/email/trash-retention-utils";
import type { TrashRetentionSettingsResponse } from "@/app/api/settings/trash-retention/types";

export function TrashRetentionSettings() {
	const { t } = useLanguage();
	const [days, setDays] = useState<number | null>(null);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		void authFetch("/api/settings/trash-retention")
			.then(async (response) => {
				const data = await response.json() as TrashRetentionSettingsResponse;
				if (!response.ok) throw new Error(typeof data.error === "string" ? data.error : t("settings.trash.loadFailed"));
				setDays(data.days ?? null);
			})
			.catch((nextError) => setError(nextError instanceof Error ? nextError.message : t("settings.trash.loadFailed")))
			.finally(() => setLoading(false));
	}, []);

	async function updateDays(nextDays: number | null) {
		const previous = days;
		setDays(nextDays);
		setLoading(true);
		setError(null);
		try {
			const response = await authFetch("/api/settings/trash-retention", {
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ days: nextDays }),
			});
			const data = await response.json() as TrashRetentionSettingsResponse;
			if (!response.ok) throw new Error(typeof data.error === "string" ? data.error : t("settings.trash.updateFailed"));
			setDays(data.days ?? null);
		} catch (nextError) {
			setDays(previous);
			setError(nextError instanceof Error ? nextError.message : t("settings.trash.updateFailed"));
		} finally {
			setLoading(false);
		}
	}

	// Keep a custom value set through the API selectable instead of silently showing "Never".
	const options: number[] = days && !(TRASH_RETENTION_OPTIONS as readonly number[]).includes(days)
		? [...TRASH_RETENTION_OPTIONS, days].sort((a, b) => a - b)
		: [...TRASH_RETENTION_OPTIONS];

	return (
		<div>
			<label className="flex items-start gap-3 rounded-xl bg-neutral-50 p-4">
				<span className="flex-1">
					<span className="block text-sm font-medium text-neutral-900">{t("settings.trash.title")}</span>
					<span className="mt-1 block text-sm text-neutral-500">
						{t("settings.trash.description")}
					</span>
				</span>
				<CustomSelect
					value={days ?? ""}
					disabled={loading}
					onChange={(event) => void updateDays(event.target.value ? Number(event.target.value) : null)}
					className="rounded-lg border border-neutral-200 bg-white px-3 py-1.5 text-sm text-neutral-800 disabled:opacity-60"
					aria-label={t("settings.trash.title")}
				>
					<option value="">{describeTrashRetention(null, t)}</option>
					{options.map((value) => (
						<option key={value} value={value}>{describeTrashRetention(value, t)}</option>
					))}
				</CustomSelect>
			</label>
			{error && <p role="alert" className="mt-2 px-4 text-sm text-red-600">{error}</p>}
		</div>
	);
}

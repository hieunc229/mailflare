"use client";

import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useLanguage } from "@/components/language-provider";
import { Button } from "@/components/ui/button";
import { authFetch } from "@/lib/auth/client";

type Preview = {
	action: "delete" | "update";
	events: { id: string; title: string; repeats: boolean; startsAt: string }[];
	changes: Record<string, unknown>[] | null;
};

function CalendarReview() {
	const { t } = useLanguage();
	const router = useRouter();
	const token = useSearchParams().get("token") ?? "";
	const [preview, setPreview] = useState<Preview | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [done, setDone] = useState(false);
	const [busy, setBusy] = useState(false);

	useEffect(() => {
		void authFetch(`/api/agent/calendar-confirmation?token=${encodeURIComponent(token)}`).then(async (response) => {
			const data = await response.json() as Preview & { error?: string };
			if (!response.ok) throw new Error(data.error || t("agent.calendarReview.loadFailed"));
			setPreview(data);
		}).catch((cause) => setError(cause instanceof Error ? cause.message : t("agent.calendarReview.loadFailed")));
	}, [token, t]);

	async function confirm() {
		setBusy(true);
		try {
			const response = await authFetch("/api/agent/calendar-confirmation", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token }) });
			const data = await response.json() as { error?: string };
			if (!response.ok) throw new Error(data.error || t("agent.calendarReview.failed"));
			setDone(true);
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : t("agent.calendarReview.failed"));
		} finally {
			setBusy(false);
		}
	}

	return <div className="max-w-2xl p-8">
		<h1 className="text-2xl font-semibold">{t("agent.calendarReview.title")}</h1>
		{error && <p role="alert" className="mt-4 text-red-600">{error}</p>}
		{!error && !preview && <p className="mt-4">{t("agent.calendarReview.loading")}</p>}
		{done && <p className="mt-4">{t("agent.calendarReview.done")}</p>}
		{preview && !done && <>
			<p className="mt-4">{preview.action === "delete" ? t("agent.calendarReview.deleteIntro") : t("agent.calendarReview.updateIntro")}</p>
			<ul className="mt-2 list-disc pl-6">
				{preview.events.map((event) => <li key={event.id}>{event.title} · {new Date(event.startsAt).toLocaleString()}{event.repeats ? ` · ${t("agent.calendarReview.repeats")}` : ""}</li>)}
			</ul>
			{preview.changes && <pre className="mt-4 overflow-x-auto rounded bg-muted p-3 text-xs">{JSON.stringify(preview.changes, null, 2)}</pre>}
			<div className="mt-6 flex gap-2">
				<Button onClick={confirm} disabled={busy} variant={preview.action === "delete" ? "destructive" : "default"}>{preview.action === "delete" ? t("agent.calendarReview.confirmDelete") : t("agent.calendarReview.confirmUpdate")}</Button>
				<Button variant="outline" onClick={() => router.back()}>{t("agent.calendarReview.cancel")}</Button>
			</div>
		</>}
	</div>;
}

export default function CalendarReviewPage() {
	return <Suspense><CalendarReview /></Suspense>;
}

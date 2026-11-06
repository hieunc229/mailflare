"use client";

import { useState } from "react";
import toast from "react-hot-toast";
import { Copy } from "@/components/icons";
import { useLanguage } from "@/components/language-provider";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { authFetch } from "@/lib/auth/client";

export function CalendarSubscribeDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
	const { t } = useLanguage();
	const [url, setUrl] = useState("");
	const [pending, setPending] = useState(false);

	async function createLink() {
		setPending(true);
		try {
			// A key that can only read the calendar: it cannot open mail, and Settings, API keys revokes it.
			const response = await authFetch("/api/api-keys", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ name: `Calendar subscription ${new Date().toISOString().slice(0, 10)}`, scopes: ["calendar:read"], mailboxIds: [] }),
			});
			const data = await response.json().catch(() => ({})) as { key?: string };
			if (!response.ok || !data.key) throw new Error(t("calendar.subscribe.failed"));
			setUrl(`${window.location.origin}/api/calendar/feed?key=${encodeURIComponent(data.key)}`);
		} catch (error) {
			toast.error(error instanceof Error ? error.message : t("calendar.subscribe.failed"));
		} finally {
			setPending(false);
		}
	}

	async function copy() {
		try {
			await navigator.clipboard.writeText(url);
			toast.success(t("calendar.subscribe.copied"));
		} catch {
			toast.error(t("calendar.subscribe.copyFailed"));
		}
	}

	return (
		<Dialog open={open} onOpenChange={(next) => { if (!next) setUrl(""); onOpenChange(next); }}>
			<DialogContent className="max-h-[calc(100vh-4rem)] w-[min(560px,calc(100vw-32px))] overflow-y-auto">
				<DialogHeader>
					<DialogTitle>{t("calendar.subscribe.title")}</DialogTitle>
					<DialogDescription>{t("calendar.subscribe.description")}</DialogDescription>
				</DialogHeader>
				{url ? (
					<div className="space-y-4 text-sm text-neutral-700">
						<div className="flex items-center gap-2">
							<input readOnly value={url} aria-label={t("calendar.subscribe.link")} onFocus={(event) => event.currentTarget.select()} className="h-10 min-w-0 flex-1 rounded-lg border border-neutral-200 bg-neutral-50 px-3 text-xs" />
							<Button onClick={() => void copy()} variant="outline" className="shrink-0 px-3"><Copy className="h-4 w-4" />{t("calendar.subscribe.copy")}</Button>
						</div>
						<p className="font-medium text-amber-900">{t("calendar.subscribe.once")}</p>
						<ul className="list-disc space-y-1 pl-5">
							<li>{t("calendar.subscribe.google")}</li>
							<li>{t("calendar.subscribe.outlook")}</li>
							<li>{t("calendar.subscribe.apple")}</li>
						</ul>
						<p className="text-neutral-500">{t("calendar.subscribe.revoke")}</p>
					</div>
				) : (
					<div className="space-y-4 text-sm text-neutral-700">
						<p>{t("calendar.subscribe.explain")}</p>
						<Button disabled={pending} onClick={() => void createLink()}>{t("calendar.subscribe.create")}</Button>
					</div>
				)}
			</DialogContent>
		</Dialog>
	);
}

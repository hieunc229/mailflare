"use client";

import { useState } from "react";
import toast from "react-hot-toast";
import { useLanguage } from "@/components/language-provider";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { authFetch } from "@/lib/auth/client";
import { formatEventRange } from "./utils";
import type { CalendarEvent } from "./types";

type Answer = "accepted" | "tentative" | "declined";

export function InviteResponseDialog({ event, onClose, onAnswered }: { event: CalendarEvent | null; onClose: () => void; onAnswered: () => void }) {
	const { t } = useLanguage();
	const [pending, setPending] = useState<Answer | null>(null);

	async function respond(answer: Answer) {
		if (!event?.inviteMessageId) return;
		setPending(answer);
		try {
			const response = await authFetch(`/api/messages/${event.inviteMessageId}/invite`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ response: answer }) });
			const data = await response.json().catch(() => ({})) as { error?: string };
			if (!response.ok) throw new Error(data.error ?? t("invite.failed"));
			toast.success(answer === "declined" ? t("invite.declined") : t("invite.added"));
			onAnswered();
			onClose();
		} catch (error) {
			toast.error(error instanceof Error ? error.message : t("invite.failed"));
		} finally {
			setPending(null);
		}
	}

	return (
		<Dialog open={event !== null} onOpenChange={(open) => { if (!open) onClose(); }}>
			<DialogContent className="max-h-[calc(100vh-4rem)] w-[min(480px,calc(100vw-32px))] overflow-y-auto">
				{event && (
					<>
						<DialogHeader>
							<DialogTitle className="break-words">{event.title}</DialogTitle>
							<DialogDescription>{t("invite.pending")}</DialogDescription>
						</DialogHeader>
						<div className="space-y-1 text-sm text-neutral-700">
							<p>{formatEventRange(event)}</p>
							{event.location && <p className="break-words text-neutral-600">{event.location}</p>}
							{event.description && <p className="whitespace-pre-wrap break-words text-neutral-600">{event.description}</p>}
						</div>
						<div className="flex flex-wrap items-center gap-2">
							<Button disabled={pending !== null} onClick={() => void respond("accepted")}>{t("invite.accept")}</Button>
							<Button disabled={pending !== null} onClick={() => void respond("tentative")} variant="outline">{t("invite.maybe")}</Button>
							<Button disabled={pending !== null} onClick={() => void respond("declined")} variant="outline">{t("invite.decline")}</Button>
							<a href={`/inbox/${event.inviteMessageId}`} className="text-sm font-medium text-blue-700 hover:underline">{t("invite.openMessage")}</a>
						</div>
					</>
				)}
			</DialogContent>
		</Dialog>
	);
}

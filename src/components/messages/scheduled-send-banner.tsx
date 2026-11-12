"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { CalendarClock } from "@/components/icons";
import { useLanguage } from "@/components/language-provider";
import { useCompose } from "@/components/compose/compose-context";
import { authFetch } from "@/lib/auth/client";
import { clearMessageDetailCache } from "@/lib/messages/detail-cache";
import { ScheduledSendReschedule } from "./scheduled-send-reschedule";
import { formatScheduledSendTime } from "./scheduled-send-utils";

/** Shown above a scheduled message; rescheduling moves the send time, editing or
 * cancelling returns it to Drafts. */
export function ScheduledSendBanner({ messageId, scheduledAt, onRescheduled }: { messageId: string; scheduledAt: string; onRescheduled?: (scheduledAt: string) => void }) {
	const { t } = useLanguage();
	const router = useRouter();
	const { openDraftComposer } = useCompose();
	const [cancelling, setCancelling] = useState(false);
	const [rescheduling, setRescheduling] = useState(false);

	async function cancelSend(edit: boolean) {
		setCancelling(true);
		try {
			const response = await authFetch(`/api/messages/${messageId}/cancel-schedule`, { method: "POST" });
			if (!response.ok) throw new Error("Unable to cancel");
			clearMessageDetailCache();
			window.dispatchEvent(new Event("mailflare:messages-changed"));
			router.push("/drafts");
			if (edit) openDraftComposer(messageId);
		} catch {
			window.alert(t("schedule.cancelFailed"));
			setCancelling(false);
		}
	}

	async function reschedule(date: Date) {
		setRescheduling(true);
		try {
			const response = await authFetch(`/api/messages/${messageId}/reschedule`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ scheduledAt: date.toISOString() }),
			});
			if (!response.ok) throw new Error("Unable to reschedule");
			clearMessageDetailCache();
			window.dispatchEvent(new Event("mailflare:messages-changed"));
			onRescheduled?.(date.toISOString());
		} catch {
			window.alert(t("schedule.rescheduleFailed"));
		} finally {
			setRescheduling(false);
		}
	}

	return (
		<div className="mx-6 mb-2 flex items-center gap-3 rounded-lg bg-neutral-100 px-4 py-3 text-sm text-neutral-600">
			<CalendarClock className="h-5 w-5 shrink-0 text-neutral-500" />
			<span className="min-w-0 flex-1">{t("schedule.sendScheduledFor", { when: formatScheduledSendTime(scheduledAt, t) })}</span>
			<ScheduledSendReschedule scheduledAt={scheduledAt} disabled={cancelling || rescheduling} onPick={(date) => void reschedule(date)} />
			<button
				type="button"
				onClick={() => void cancelSend(true)}
				disabled={cancelling || rescheduling}
				className="shrink-0 font-medium text-blue-600 hover:underline disabled:opacity-50"
			>
				{t("agent.activity.editDraft")}
			</button>
			<button
				type="button"
				onClick={() => void cancelSend(false)}
				disabled={cancelling || rescheduling}
				className="shrink-0 font-medium text-blue-600 hover:underline disabled:opacity-50"
			>
				{t("schedule.cancelSend")}
			</button>
		</div>
	);
}

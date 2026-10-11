"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ScheduledSendIcon } from "@/components/icons/scheduled-send-icon";
import { useLanguage } from "@/components/language-provider";
import { authFetch } from "@/lib/auth/client";
import { clearMessageDetailCache } from "@/lib/messages/detail-cache";
import { formatScheduledSendTime } from "./scheduled-send-utils";

/** Shown above a scheduled message; cancelling returns it to Drafts. */
export function ScheduledSendBanner({ messageId, scheduledAt }: { messageId: string; scheduledAt: string }) {
	const { t } = useLanguage();
	const router = useRouter();
	const [cancelling, setCancelling] = useState(false);

	async function cancelSend() {
		setCancelling(true);
		try {
			const response = await authFetch(`/api/messages/${messageId}/cancel-schedule`, { method: "POST" });
			if (!response.ok) throw new Error("Unable to cancel");
			clearMessageDetailCache();
			window.dispatchEvent(new Event("mailflare:messages-changed"));
			router.push("/drafts");
		} catch {
			window.alert(t("schedule.cancelFailed"));
			setCancelling(false);
		}
	}

	return (
		<div className="mx-6 mb-2 flex items-center gap-3 rounded-lg bg-neutral-100 px-4 py-3 text-sm text-neutral-600">
			<ScheduledSendIcon className="h-5 w-5 shrink-0 text-neutral-500" />
			<span className="min-w-0 flex-1">{t("schedule.sendScheduledFor", { when: formatScheduledSendTime(scheduledAt, t) })}</span>
			<button
				type="button"
				onClick={() => void cancelSend()}
				disabled={cancelling}
				className="shrink-0 font-medium text-blue-600 hover:underline disabled:opacity-50"
			>
				{t("schedule.cancelSend")}
			</button>
		</div>
	);
}

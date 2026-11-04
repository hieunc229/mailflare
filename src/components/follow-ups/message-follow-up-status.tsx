"use client";

import { useCallback, useEffect, useState } from "react";
import { BellRing, Check } from "@/components/icons";
import { useLanguage } from "@/components/language-provider";
import type { MessageFollowUp } from "@/lib/follow-ups/types";
import { formatUserDate } from "@/lib/time/utils";
import { FollowUpMenu } from "./follow-up-menu";
import { clearMessageFollowUp, fetchMessageFollowUp, FOLLOW_UPS_CHANGED_EVENT, setMessageFollowUp } from "./follow-up-client-utils";

const DATE_FORMAT: Intl.DateTimeFormatOptions = { weekday: "short", month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit" };
const LINK_CLASS = "font-medium text-blue-600 hover:underline disabled:opacity-50";

/** Reminder state of a sent message, with a way to set, move or remove it. */
export function MessageFollowUpStatus({ messageId }: { messageId: string }) {
	const { t } = useLanguage();
	const [followUp, setFollowUp] = useState<MessageFollowUp | null | undefined>(undefined);
	const [failed, setFailed] = useState(false);

	const load = useCallback(() => {
		void fetchMessageFollowUp(messageId).then(setFollowUp).catch(() => setFollowUp(null));
	}, [messageId]);

	useEffect(() => {
		load();
		window.addEventListener(FOLLOW_UPS_CHANGED_EVENT, load);
		return () => window.removeEventListener(FOLLOW_UPS_CHANGED_EVENT, load);
	}, [load]);

	function run(action: Promise<void>) {
		setFailed(false);
		void action.catch(() => setFailed(true));
	}

	if (followUp === undefined) return null;
	const open = followUp?.status === "pending" || followUp?.status === "due";

	return (
		<p className="mb-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-neutral-500">
			{followUp?.status === "replied" ? (
				<>
					<Check className="h-3.5 w-3.5" aria-hidden />
					{t("followUp.replied")}
				</>
			) : open ? (
				<>
					<BellRing className="h-3.5 w-3.5 text-amber-600" aria-hidden />
					{followUp.status === "due"
						? t("followUp.noReplyYet")
						: t("followUp.scheduledFor", { date: formatUserDate(followUp.dueAt, DATE_FORMAT) })}
					<FollowUpMenu
						trigger={<button type="button" className={LINK_CLASS}>{t("followUp.change")}</button>}
						onPick={(days) => run(setMessageFollowUp(messageId, days))}
						onClear={() => run(clearMessageFollowUp(messageId))}
					/>
				</>
			) : (
				<FollowUpMenu
					trigger={
						<button type="button" className="inline-flex items-center gap-1.5 hover:text-neutral-900">
							<BellRing className="h-3.5 w-3.5" aria-hidden />
							{t("followUp.remindMe")}
						</button>
					}
					onPick={(days) => run(setMessageFollowUp(messageId, days))}
				/>
			)}
			{failed && <span role="alert" className="text-red-600">{t("followUp.failed")}</span>}
		</p>
	);
}

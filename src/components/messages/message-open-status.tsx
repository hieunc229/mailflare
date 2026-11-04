"use client";

import { useEffect, useState } from "react";
import { Eye, EyeOff } from "@/components/icons";
import { useLanguage } from "@/components/language-provider";
import { formatUserDate } from "@/lib/time/utils";
import type { MessageTrackingSummary } from "@/lib/tracking/types";
import { describeOpenEvent, fetchMessageTracking } from "./message-open-status-utils";

const DATE_FORMAT: Intl.DateTimeFormatOptions = { month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit" };

/** Read-receipt status of a sent message; renders nothing when it was sent without a pixel. */
export function MessageOpenStatus({ messageId }: { messageId: string }) {
	const { t, locale } = useLanguage();
	const [tracking, setTracking] = useState<MessageTrackingSummary | null>(null);

	useEffect(() => {
		let cancelled = false;
		void fetchMessageTracking(messageId).then((result) => {
			if (!cancelled) setTracking(result);
		}).catch(() => undefined);
		return () => {
			cancelled = true;
		};
	}, [messageId]);

	if (!tracking) return null;

	if (tracking.openCount === 0) {
		return (
			<p className="mb-3 flex items-center gap-1.5 text-xs text-neutral-500">
				<EyeOff className="h-3.5 w-3.5" aria-hidden />
				{tracking.onlyAutomated ? t("message.opens.onlyAutomated") : t("message.opens.notYet")}
			</p>
		);
	}

	return (
		<details className="mb-3 text-xs text-neutral-600">
			<summary className="flex cursor-pointer list-none items-center gap-1.5 text-blue-700 [&::-webkit-details-marker]:hidden">
				<Eye className="h-3.5 w-3.5" aria-hidden />
				{t("message.opens.opened", {
					count: tracking.openCount,
					date: tracking.lastOpenedAt ? formatUserDate(tracking.lastOpenedAt, DATE_FORMAT) : "",
				})}
			</summary>
			<ul className="mt-2 space-y-1 border-l border-neutral-200 pl-3">
				{tracking.opens.map((event) => {
					const description = describeOpenEvent(event, locale);
					return (
						<li key={event.openedAt} className={event.automated ? "text-neutral-400" : undefined}>
							<time dateTime={event.openedAt}>{formatUserDate(event.openedAt, DATE_FORMAT)}</time>
							{description && <span> · {description}</span>}
							{event.automated && <span> · {t("message.opens.automated")}</span>}
						</li>
					);
				})}
			</ul>
			<p className="mt-2 text-neutral-400">{t("message.opens.caveat")}</p>
		</details>
	);
}

/** Eye icon on list rows whose read-receipt pixel has registered an open. */
export function OpenedIndicator({ count }: { count?: number }) {
	const { t } = useLanguage();
	if (!count) return null;
	return (
		<Eye className="mr-1 inline h-3 w-3 align-[-1px] text-blue-600" role="img" aria-label={t("list.opened", { count })} />
	);
}

"use client";

import { useState } from "react";
import { BellOff, MailCheck } from "@/components/icons";
import { useCompose } from "@/components/compose/compose-context";
import { useLanguage } from "@/components/language-provider";
import { Button } from "@/components/ui/button";
import { Tooltip } from "@/components/ui/tooltip";
import { openUnsubscribeUrl } from "@/components/message-actions/utils";
import { requestUnsubscribe } from "./unsubscribe-button-utils";

/**
 * The header-level unsubscribe action. The route decides the real mechanism —
 * one-click POST, sent mailto, or a link to open — this only reflects the
 * outcome and keeps an "Unsubscribed" state instead of offering it twice.
 */
export function MessageUnsubscribeButton({ messageId }: { messageId: string }) {
	const { t } = useLanguage();
	const { showNotice } = useCompose();
	const [pending, setPending] = useState(false);
	const [done, setDone] = useState(false);

	async function onUnsubscribe() {
		setPending(true);
		try {
			const result = await requestUnsubscribe(messageId);
			setDone(true);
			if (result.method === "link") {
				openUnsubscribeUrl(result.url);
				showNotice(t("actions.unsubscribeLinkOpened"));
			} else if (result.method === "mailto") {
				showNotice(t("actions.unsubscribeEmailSent"));
			} else {
				showNotice(t("actions.unsubscribed"));
			}
		} catch {
			showNotice(t("actions.unsubscribeFailed"), { tone: "error" });
		} finally {
			setPending(false);
		}
	}

	if (done) {
		return (
			<span role="status" className="flex items-center gap-1 px-1 text-xs font-medium text-green-700">
				<MailCheck className="h-4 w-4" aria-hidden="true" />
				{t("actions.unsubscribed")}
			</span>
		);
	}
	return (
		<Tooltip label={t("actions.unsubscribe")}>
			<Button
				type="button"
				variant="ghost"
				size="sm"
				className="h-8 w-8 px-0"
				aria-label={t("actions.unsubscribe")}
				disabled={pending}
				onClick={() => void onUnsubscribe()}
			>
				<BellOff className="h-4 w-4" />
			</Button>
		</Tooltip>
	);
}

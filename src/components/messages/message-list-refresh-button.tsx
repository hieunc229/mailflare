"use client";

import { useRef, useState } from "react";
import { RefreshCw } from "@/components/icons";
import { useLanguage } from "@/components/language-provider";
import { Button } from "@/components/ui/button";
import { Tooltip } from "@/components/ui/tooltip";
import { refreshMessageViews } from "@/hooks/message-refresh";

export function MessageListRefreshButton({ disabled = false, onError }: {
	disabled?: boolean;
	onError?: () => void;
}) {
	const { t } = useLanguage();
	const [refreshing, setRefreshing] = useState(false);
	const pending = useRef(false);

	async function refresh() {
		if (pending.current) return;
		pending.current = true;
		setRefreshing(true);
		try {
			await refreshMessageViews();
		} catch {
			onError?.();
		} finally {
			pending.current = false;
			setRefreshing(false);
		}
	}

	const label = refreshing ? t("list.refreshing") : t("list.refresh");
	return (
		<>
			<Tooltip label={label}>
				<Button
					type="button"
					variant="ghost"
					size="sm"
					disabled={disabled || refreshing}
					aria-label={label}
					aria-busy={refreshing}
					onClick={() => void refresh()}
				>
					<RefreshCw className={`h-4 w-4 ${refreshing ? "animate-spin" : ""}`} aria-hidden="true" />
				</Button>
			</Tooltip>
			<span role="status" aria-live="polite" className="sr-only">
				{refreshing ? t("list.refreshing") : ""}
			</span>
		</>
	);
}

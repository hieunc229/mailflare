import { useEffect, useState } from "react";
import { setAppBadgeCount } from "@/lib/push/app-badge";
import { useMessageCounts } from "./use-message-counts";

/** Mirrors the all-mailbox inbox unread count onto the installed app's icon. */
export function useAppBadge() {
	const [supported] = useState(() => typeof navigator !== "undefined" && "setAppBadge" in navigator);
	const { counts, isLoading } = useMessageCounts(null, supported);
	const [placeholderCounts] = useState(counts);
	const unread = counts.folders.inbox.unread;
	// The placeholder (before the first load, or after a failed one) must not clear a badge the service worker set.
	const known = !isLoading && counts !== placeholderCounts;

	useEffect(() => {
		if (supported && known) setAppBadgeCount(unread);
	}, [supported, known, unread]);
}

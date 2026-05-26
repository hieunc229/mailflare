import { useEffect, useState } from "react";
import type { MessageCounts } from "./types";

const emptyCounts: MessageCounts = {
	folders: {
		inbox: { total: 0, unread: 0 },
		sent: { total: 0, unread: 0 },
		drafts: { total: 0, unread: 0 },
		spam: { total: 0, unread: 0 },
		trash: { total: 0, unread: 0 },
	},
	mailboxes: [],
};

export function useMessageCounts(mailboxId?: string | null) {
	const [counts, setCounts] = useState<MessageCounts>(emptyCounts);
	const [isLoading, setIsLoading] = useState(true);

	useEffect(() => {
		let cancelled = false;

		async function loadCounts() {
			setIsLoading(true);
			try {
				const params = new URLSearchParams();
				if (mailboxId) params.set("mailboxId", mailboxId);
				const res = await fetch(`/api/messages/counts?${params.toString()}`);
				const data = (await res.json()) as { counts?: MessageCounts };
				if (!cancelled) setCounts(data.counts ?? emptyCounts);
			} finally {
				if (!cancelled) setIsLoading(false);
			}
		}

		void loadCounts();
		window.addEventListener("mailflare:messages-changed", loadCounts);

		return () => {
			cancelled = true;
			window.removeEventListener("mailflare:messages-changed", loadCounts);
		};
	}, [mailboxId]);

	return { counts, isLoading };
}

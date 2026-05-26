import { useEffect, useState } from "react";
import type { Message, MessageFilterOptions, MessageFolder } from "./types";
import { getMessageQueryParams } from "./utils";

export function useMessages(
	folder: MessageFolder,
	mailboxId?: string | null,
	filters?: MessageFilterOptions,
) {
	const [messages, setMessages] = useState<Message[]>([]);
	const [isLoading, setIsLoading] = useState(true);

	const unreadCount = messages.filter((m) => m.direction === "inbound" && !m.read).length;

	useEffect(() => {
		let cancelled = false;
		async function loadMessages() {
			setIsLoading(true);
			try {
				const params = getMessageQueryParams(folder, mailboxId, filters);
				const res = await fetch(`/api/messages?${params.toString()}`);
				const data = (await res.json()) as { messages?: Message[] };
				if (!cancelled) setMessages(data.messages ?? []);
			} finally {
				if (!cancelled) setIsLoading(false);
			}
		}

		void loadMessages();
		window.addEventListener("mailflare:messages-changed", loadMessages);

		return () => {
			cancelled = true;
			window.removeEventListener("mailflare:messages-changed", loadMessages);
		};
	}, [filters?.query, filters?.read, filters?.title, folder, mailboxId]);

	return { messages, unreadCount, isLoading };
}

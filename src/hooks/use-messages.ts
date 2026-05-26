import { useEffect, useState } from "react";
import type { Message, MessageFolder } from "./types";
import { getMessageQueryParams } from "./utils";

export function useMessages(folder: MessageFolder, mailboxId?: string | null) {
	const [messages, setMessages] = useState<Message[]>([]);
	const [isLoading, setIsLoading] = useState(true);

	const unreadCount = messages.filter((m) => m.direction === "inbound" && !m.read).length;

	useEffect(() => {
		setIsLoading(true);
		const params = getMessageQueryParams(folder, mailboxId);
		fetch(`/api/messages?${params.toString()}`)
			.then((res) => res.json())
			.then((data) => {
				const msgs = (data as { messages?: Message[] }).messages ?? [];
				setMessages(msgs);
				setIsLoading(false);
			})
			.catch(() => setIsLoading(false));
	}, [folder, mailboxId]);

	return { messages, unreadCount, isLoading };
}

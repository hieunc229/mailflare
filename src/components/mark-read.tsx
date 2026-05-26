"use client";

import { useEffect } from "react";

export function MarkAsRead({ messageId }: { messageId: string }) {
	useEffect(() => {
		fetch(`/api/messages/${messageId}/read`, { method: "POST" })
			.then((response) => {
				if (response.ok) window.dispatchEvent(new Event("mailflare:messages-changed"));
			})
			.catch(() => {
				// silently fail
			});
	}, [messageId]);

	return null;
}

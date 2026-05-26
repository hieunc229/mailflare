"use client";

import { useEffect } from "react";

export function MarkAsRead({ messageId }: { messageId: string }) {
	useEffect(() => {
		fetch(`/api/messages/${messageId}/read`, { method: "POST" }).catch(() => {
			// silently fail
		});
	}, [messageId]);

	return null;
}

"use client";

import { authFetch } from "@/lib/auth/client";
import { markMessagesReadInCaches } from "@/hooks/utils";

/** Mark a message read after it is opened, and mirror the change into client caches. */
export async function markMessageRead(messageId: string) {
	try {
		const response = await authFetch(`/api/messages/${messageId}/read`, { method: "POST" });
		if (!response.ok) return;
		markMessagesReadInCaches([messageId], true);
		window.dispatchEvent(new Event("mailflare:messages-changed"));
	} catch {
		// silently fail
	}
}

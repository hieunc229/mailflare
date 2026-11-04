"use client";

import { useEffect } from "react";
import { usePathname, useRouter } from "next/navigation";
import { authFetch } from "@/lib/auth/client";
import { clearMessageDetailCache } from "@/lib/messages/detail-cache";
import { resolveSendViewRoute } from "./send-view-utils";

/** Keep a scheduled reader on the delivered message, or close it after Undo. */
export function useSendViewStatus(messageId: string) {
	const pathname = usePathname();
	const router = useRouter();
	useEffect(() => {
		const scheduled = pathname === `/scheduled/${messageId}`;
		if (!scheduled && pathname !== `/sent/${messageId}`) return;
		let disposed = false;
		let checking = false;
		let checkAgain = false;
		let moved = false;
		async function check() {
			if (disposed || moved) return;
			if (checking) { checkAgain = true; return; }
			checking = true;
			try {
				const response = await authFetch(`/api/messages/${messageId}/send-status`, { cache: "no-store" });
				if (!response.ok) return;
				const { status } = await response.json() as { status?: string };
				if (disposed || !status) return;
				const destination = resolveSendViewRoute(pathname, messageId, status);
				if (!destination) return;
				moved = true;
				clearMessageDetailCache();
				window.dispatchEvent(new Event("mailflare:messages-changed"));
				router.replace(destination);
			} catch {
				// Transient failures are retried by the timer or the next change event.
			} finally {
				checking = false;
				if (checkAgain && !disposed) { checkAgain = false; void check(); }
			}
		}
		const onChange = () => void check();
		void check();
		const timer = scheduled ? window.setInterval(onChange, 1000) : undefined;
		window.addEventListener("mailflare:messages-changed", onChange);
		return () => {
			disposed = true;
			if (timer !== undefined) window.clearInterval(timer);
			window.removeEventListener("mailflare:messages-changed", onChange);
		};
	}, [messageId, pathname, router]);
}

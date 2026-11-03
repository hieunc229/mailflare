"use client";

import { useEffect } from "react";
import { usePathname, useRouter } from "next/navigation";
import { authFetch } from "@/lib/auth/client";
import { clearMessageDetailCache } from "@/lib/messages/detail-cache";
import { resolveSendViewRoute } from "./send-view-utils";

/** Keep a scheduled reader on the delivered message, or close it after Undo. */
export function useSendViewStatus(messageId: string, scheduledAt?: string | null) {
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
				// Transient failures wait for the next change event or fallback check.
			} finally {
				checking = false;
				if (checkAgain && !disposed) { checkAgain = false; void check(); }
			}
		}
		const onChange = () => void check();
		void check();

		let deadlineTimer: number | undefined;
		let fallbackTimer: number | undefined;
		if (scheduled && scheduledAt) {
			const deadline = new Date(scheduledAt).getTime();
			if (Number.isFinite(deadline)) {
				const startFallback = () => {
					void check();
					fallbackTimer = window.setInterval(onChange, 10_000);
				};
				const delay = deadline - Date.now();
				if (delay <= 0) startFallback();
				else deadlineTimer = window.setTimeout(startFallback, delay);
			}
		} else if (scheduled) {
			// The detail response may not have supplied the job's time yet.
			fallbackTimer = window.setInterval(onChange, 15_000);
		}

		window.addEventListener("mailflare:messages-changed", onChange);
		return () => {
			disposed = true;
			if (deadlineTimer !== undefined) window.clearTimeout(deadlineTimer);
			if (fallbackTimer !== undefined) window.clearInterval(fallbackTimer);
			window.removeEventListener("mailflare:messages-changed", onChange);
		};
	}, [messageId, pathname, router, scheduledAt]);
}

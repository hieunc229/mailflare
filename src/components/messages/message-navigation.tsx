"use client";

import { useEffect, useRef, useState } from "react";
import type { MouseEvent } from "react";
import { usePathname, useRouter } from "next/navigation";
import { fetchCachedMessageDetail, getCachedMessageDetail, primeMessageDetail } from "@/lib/messages/detail-cache";
import type { Message } from "@/hooks/types";
import type { MessageNavigationState } from "./message-navigation-types";

const HOVER_PREFETCH_DELAY_MS = 120;

export function useMessageNavigation(href: string, message: Message): MessageNavigationState {
	const pathname = usePathname();
	const router = useRouter();
	const [progress, setProgress] = useState<number | null>(null);
	const hoverTimer = useRef<number | null>(null);
	const idleCallback = useRef<number | null>(null);

	useEffect(() => {
		if (progress === null) return;
		setProgress(100);
		const timer = window.setTimeout(() => setProgress(null), 220);
		return () => window.clearTimeout(timer);
	}, [pathname]);

	useEffect(() => () => {
		if (hoverTimer.current) window.clearTimeout(hoverTimer.current);
		if (idleCallback.current !== null && "cancelIdleCallback" in window) window.cancelIdleCallback(idleCallback.current);
	}, []);

	function prefetch() {
		if (hoverTimer.current || getCachedMessageDetail(message.id)?.body) return;
		hoverTimer.current = window.setTimeout(() => {
			hoverTimer.current = null;
			// Seed the header at once so the reader has something to paint while
			// the body request is in flight.
			primeMessageDetail({ ...message, read: message.read });
			const warm = () => { void fetchCachedMessageDetail(message.id, true).catch(() => {}); };
			if ("requestIdleCallback" in window) {
				idleCallback.current = window.requestIdleCallback(warm, { timeout: 400 });
			} else {
				warm();
			}
		}, HOVER_PREFETCH_DELAY_MS);
	}

	function cancelPrefetch() {
		if (hoverTimer.current) {
			window.clearTimeout(hoverTimer.current);
			hoverTimer.current = null;
		}
		if (idleCallback.current !== null && "cancelIdleCallback" in window) {
			window.cancelIdleCallback(idleCallback.current);
			idleCallback.current = null;
		}
	}

	function onNavigate(event: MouseEvent<HTMLAnchorElement>, markRead = false) {
		if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
		event.preventDefault();
		primeMessageDetail({ ...message, read: markRead || message.read });
		setProgress(12);
		try {
			router.push(href);
		} catch {
			setProgress(null);
		}
	}

	return { progress, onNavigate, prefetch, cancelPrefetch };
}

export function MessageNavigationProgress({ progress }: { progress: number | null }) {
	if (progress === null) return null;
	return (
		<div className="fixed inset-x-0 top-0 z-[120] h-1 bg-blue-100">
			<div className="h-full bg-blue-600 transition-[width] duration-100 ease-out" style={{ width: `${progress}%` }} />
		</div>
	);
}

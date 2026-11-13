"use client";

import { useEffect, useRef } from "react";
import type { MouseEvent } from "react";
import { useRouter } from "next/navigation";
import { fetchCachedMessageDetail, getCachedMessageDetail, primeMessageDetail } from "@/lib/messages/detail-cache";
import { FULL_ROUTE_PREFETCH } from "@/lib/navigation/prefetch";
import type { Message } from "@/hooks/types";
import type { MessageNavigationState } from "./message-navigation-types";

const HOVER_PREFETCH_DELAY_MS = 120;

export function useMessageNavigation(href: string, message: Message): MessageNavigationState {
	const router = useRouter();
	const hoverTimer = useRef<number | null>(null);
	const idleCallback = useRef<number | null>(null);
	const routePrefetched = useRef(false);

	useEffect(() => () => {
		if (hoverTimer.current) window.clearTimeout(hoverTimer.current);
		if (idleCallback.current !== null && "cancelIdleCallback" in window) window.cancelIdleCallback(idleCallback.current);
	}, []);

	function prefetchRoute() {
		if (routePrefetched.current) return;
		routePrefetched.current = true;
		// A dynamic route only gets a shell from automatic prefetch.
		router.prefetch(href, FULL_ROUTE_PREFETCH);
	}

	function warmDetail() {
		if (getCachedMessageDetail(message.id)?.body) return;
		// Seed the header while the body loads.
		primeMessageDetail({ ...message, read: message.read });
		void fetchCachedMessageDetail(message.id, true).catch(() => {});
	}

	function prefetch() {
		prefetchRoute();
		if (hoverTimer.current || getCachedMessageDetail(message.id)?.body) return;
		hoverTimer.current = window.setTimeout(() => {
			hoverTimer.current = null;
			if ("requestIdleCallback" in window) {
				idleCallback.current = window.requestIdleCallback(warmDetail, { timeout: 400 });
			} else {
				warmDetail();
			}
		}, HOVER_PREFETCH_DELAY_MS);
	}

	function prefetchNow() {
		prefetchRoute();
		warmDetail();
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
		prefetchRoute();
		primeMessageDetail({ ...message, read: markRead || message.read });
		router.push(href);
	}

	return { onNavigate, prefetch, prefetchNow, cancelPrefetch };
}

"use client";

import { useCallback, useSyncExternalStore } from "react";

const mobileQuery = "(max-width: 767px)";
const desktopQuery = "(min-width: 1024px)";

function useMediaQuery(query: string): boolean {
	const subscribe = useCallback((onChange: () => void) => {
		const media = window.matchMedia(query);
		media.addEventListener("change", onChange);
		return () => media.removeEventListener("change", onChange);
	}, [query]);
	const getSnapshot = useCallback(() => window.matchMedia(query).matches, [query]);
	return useSyncExternalStore(subscribe, getSnapshot, () => false);
}

export function isMobileViewport(): boolean {
	return window.matchMedia(mobileQuery).matches;
}

export function useIsMobile(): boolean {
	return useMediaQuery(mobileQuery);
}

/** Whether the split message list is actually rendered beside the reader. */
export function useIsDesktop(): boolean {
	return useMediaQuery(desktopQuery);
}

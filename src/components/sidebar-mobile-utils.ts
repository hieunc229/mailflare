"use client";

import { useCallback, useSyncExternalStore } from "react";

const mobileQuery = "(max-width: 767px)";
const singleColumnQuery = "(max-width: 768px)";
const desktopQuery = "(min-width: 1024px)";
const hoverQuery = "(hover: hover) and (pointer: fine)";

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

/** Whether the viewport is too narrow for the list and reader to sit side by side. */
export function useIsSingleColumnViewport(): boolean {
	return useMediaQuery(singleColumnQuery);
}

/** Whether the split message list is actually rendered beside the reader. */
export function useIsDesktop(): boolean {
	return useMediaQuery(desktopQuery);
}

/** Whether the primary pointer can hover; coarse touch screens get no hover rail. */
export function useHasHover(): boolean {
	return useMediaQuery(hoverQuery);
}

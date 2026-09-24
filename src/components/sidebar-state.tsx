"use client";

import { usePathname } from "next/navigation";
import { createContext, useContext, useEffect, useState, useSyncExternalStore } from "react";
import { readColumnWidth } from "./column-width-preferences";
import type { SidebarProviderProps, SidebarState } from "./sidebar-state-types";

// Below md the sidebar is a 72px icon rail; expanding it overlays the content instead of squeezing it.
const mobileQuery = "(max-width: 767px)";
const isMobile = () => window.matchMedia(mobileQuery).matches;

export function useIsMobile() {
	return useSyncExternalStore(
		(onChange) => {
			const media = window.matchMedia(mobileQuery);
			media.addEventListener("change", onChange);
			return () => media.removeEventListener("change", onChange);
		},
		isMobile,
		() => false,
	);
}

const SidebarContext = createContext<SidebarState>({ minimal: false, width: 260, userId: null, toggle: () => undefined, setWidth: () => undefined, setForcedMinimal: () => undefined });

export function SidebarProvider({ children, expandedWidth = 260 }: SidebarProviderProps) {
	const [minimal, setMinimal] = useState(false);
	const [forcedMinimal, setForcedMinimal] = useState(false);
	const [width, setWidth] = useState(expandedWidth);
	const [userId, setUserId] = useState<string | null>(null);
	const [storageKey, setStorageKey] = useState<string | null>(null);
	const pathname = usePathname();

	// Collapse on first load and after every navigation on phones, so the overlay never sticks open.
	useEffect(() => {
		if (isMobile()) setMinimal(true);
	}, [pathname]);

	useEffect(() => {
		// The sidebar preference is cosmetic, so every failure here degrades to the default.
		// Guard the parse: an error response may carry an empty or non-JSON body, and an
		// unhandled rejection here surfaces as a confusing SyntaxError overlay in dev.
		void fetch("/api/auth/me", { cache: "no-store" })
			.then(async (response) => {
				if (!response.ok) return null;
				return (await response.json().catch(() => null)) as { user?: { id?: string } } | null;
			})
			.then((data) => {
				const userId = data?.user?.id;
					if (!userId) return;
					setUserId(userId);
					const key = `mailflare-sidebar-minimal:${userId}`;
				setStorageKey(key);
				if (isMobile()) return;
				try {
						setMinimal(localStorage.getItem(key) === "true");
						setWidth(readColumnWidth(userId, "sidebar", expandedWidth, 200, 480));
				} catch {
					// Storage can be unavailable in private windows; keep the default.
				}
			})
			.catch(() => undefined);
	}, []);

	function toggle() {
		if (forcedMinimal) {
			setForcedMinimal(false);
			setMinimal(false);
			if (storageKey && !isMobile()) localStorage.setItem(storageKey, "false");
			return;
		}
		setMinimal((current) => {
			const next = !current;
			if (storageKey && !isMobile()) localStorage.setItem(storageKey, String(next));
			return next;
		});
	}

	return (
		<SidebarContext.Provider value={{ minimal: minimal || forcedMinimal, width, userId, toggle, setWidth, setForcedMinimal }}>
			<div className="h-full" style={{ "--sidebar-width": `${minimal || forcedMinimal ? 72 : width}px` } as React.CSSProperties}>
				{children}
			</div>
		</SidebarContext.Provider>
	);
}

export function useSidebar() {
	return useContext(SidebarContext);
}

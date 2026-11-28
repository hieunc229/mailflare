"use client";

import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Branding } from "@/lib/branding/types";
import type { BrandingContextValue } from "./branding-provider-types";
import { DEFAULT_BRANDING, fetchBranding } from "./branding-provider-utils";

const BrandingContext = createContext<BrandingContextValue | null>(null);

export function BrandingProvider({ children, initialBranding }: { children: React.ReactNode; initialBranding?: Branding }) {
	const [branding, setBranding] = useState(initialBranding ?? DEFAULT_BRANDING);
	const [iconVersion, setIconVersion] = useState(0);

	function applyBranding(nextBranding: Branding) {
		setBranding(nextBranding);
		setIconVersion(Date.now());
		if (document.title === "Mailflare" || document.title === branding.appName) {
			document.title = nextBranding.appName;
		}
	}

	// Stable identity: consumers must not re-render because the provider did.
	const applyRef = useRef(applyBranding);
	useLayoutEffect(() => {
		applyRef.current = applyBranding;
	});
	const refreshBranding = useCallback(async () => {
		applyRef.current(await fetchBranding());
	}, []);

	const value = useMemo(() => ({
		...branding,
		iconUrl: branding.hasCustomIcon ? `/api/branding/icon?v=${iconVersion}` : "/icon-96.png",
		refreshBranding,
	}), [branding, iconVersion, refreshBranding]);

	useEffect(() => {
		// The server layout already supplied the branding; refetching it on mount is
		// a second round trip that competes with the rest of the boot.
		if (!initialBranding) void fetchBranding().then(applyBranding);
	}, [initialBranding]);

	return (
		<BrandingContext.Provider value={value}>
			{children}
		</BrandingContext.Provider>
	);
}

export function useBranding() {
	return useContext(BrandingContext) ?? {
		...DEFAULT_BRANDING,
		iconUrl: "/icon-96.png",
		refreshBranding: async () => undefined,
	};
}

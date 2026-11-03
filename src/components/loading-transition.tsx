"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useBranding } from "@/components/branding-provider";
import { useLanguage } from "@/components/language-provider";
import { PageLoadingContext } from "@/components/page-loading";
import { RouteLoadingBar } from "@/components/route-loading-bar";
import type { LoadingTransitionProps } from "./loading-transition-types";

const SPLASH_DELAY_MS = 100;
let hasShownInitialLoadingTransition = false;

export function LoadingTransition({ children, ready }: LoadingTransitionProps) {
	const { t } = useLanguage();
	const branding = useBranding();
	const showInitialLoader = useRef(!hasShownInitialLoadingTransition).current;
	const [splashVisible, setSplashVisible] = useState(false);
	const [iconUrl, setIconUrl] = useState(branding.iconUrl);
	const [visibleLoads, setVisibleLoads] = useState(0);
	const visibleIds = useRef(new Set<string>());

	const reportLoading = useCallback((id: string, loading: boolean, silent = false) => {
		if (loading && !silent) visibleIds.current.add(id);
		else visibleIds.current.delete(id);
		setVisibleLoads(visibleIds.current.size);
	}, []);
	const loadingContext = useMemo(() => ({ reportLoading }), [reportLoading]);

	useEffect(() => {
		setIconUrl(branding.iconUrl);
	}, [branding.iconUrl]);

	useEffect(() => {
		if (!showInitialLoader) return;
		hasShownInitialLoadingTransition = true;
		if (ready) return;
		const timer = window.setTimeout(() => setSplashVisible(true), SPLASH_DELAY_MS);
		return () => window.clearTimeout(timer);
	}, [ready, showInitialLoader]);

	useEffect(() => {
		if (ready) setSplashVisible(false);
	}, [ready]);

	const initialLoadComplete = !showInitialLoader || ready;
	const contentVisible = !showInitialLoader || ready;
	const showTopLoadingBar = initialLoadComplete && (!ready || visibleLoads > 0);

	return (
		<PageLoadingContext.Provider value={loadingContext}>
			<div className="relative min-h-dvh bg-[#f6f8fc]">
				{showTopLoadingBar && <RouteLoadingBar />}
				{ready && (
					<div
						className={`min-h-dvh transition-opacity duration-150 ${contentVisible ? "opacity-100" : "opacity-0"}`}
					>
						{children}
					</div>
				)}
				<div
					role="status"
					className={`fixed inset-0 z-[100] flex items-center justify-center bg-[#f6f8fc] transition-opacity duration-150 ${
						splashVisible ? "opacity-100" : "pointer-events-none opacity-0"
					}`}
				>
					<span className="sr-only">{splashVisible ? t("nav.loading") : ""}</span>
					<div aria-hidden="true" className="flex w-64 flex-col items-center gap-6">
						<img
							src={iconUrl}
							onError={() => setIconUrl("/icon-192.png")}
							alt=""
							className="h-20 w-20 rounded-2xl object-contain"
						/>
						<div className="h-1.5 w-full overflow-hidden rounded-full bg-blue-100">
							<div className="route-loading-bar h-full w-2/5 rounded-full bg-blue-600" />
						</div>
					</div>
				</div>
			</div>
		</PageLoadingContext.Provider>
	);
}
